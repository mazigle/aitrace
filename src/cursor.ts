import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Session, SessionEntry } from './format.js';
import { formatFilename, generateMarkdown } from './format.js';
import { getCursorDbPath } from './paths.js';
import { debug, ensureDir, exists, log, logError } from './utils.js';

interface Bubble {
  type: number; // 1 = user, 2 = assistant
  text?: string;
  bubbleId: string;
  attachedFileCodeChunksUris?: Array<{ path: string }>;
  codeBlocks?: Array<{ uri?: { path?: string } }>;
  timingInfo?: {
    clientStartTime?: number;
    clientRpcSendTime?: number;
  };
}

interface ComposerData {
  composerId: string;
  fullConversationHeadersOnly: Array<{
    bubbleId: string;
    type: number;
  }>;
}

interface KVRow {
  key: string;
  value: string;
}

function getTimestampFromBubble(bubble: Bubble): Date {
  if (bubble.timingInfo?.clientRpcSendTime) {
    return new Date(bubble.timingInfo.clientRpcSendTime);
  }
  return new Date();
}

function bubbleBelongsToProject(bubbleJson: string, projectPath: string): boolean {
  // Simple string check - if project path appears anywhere in the bubble JSON
  return bubbleJson.includes(projectPath);
}

interface BubbleWithJson {
  bubble: Bubble;
  json: string;
}

function isValidBubble(obj: unknown): obj is Bubble {
  if (!obj || typeof obj !== 'object') return false;
  const b = obj as Record<string, unknown>;
  return (
    typeof b.composerMetadataId === 'string' &&
    typeof b.bubbleId === 'string' &&
    typeof b.text === 'string'
  );
}

function buildSession(
  bubbles: Map<string, BubbleWithJson>,
  composerData: ComposerData,
  projectPath: string
): Session | null {
  const entries: SessionEntry[] = [];
  let firstTimestamp: Date | null = null;
  let lastTimestamp: Date | null = null;
  let belongsToProject = false;
  let firstUserMessage = '';
  let currentEntry: SessionEntry | null = null;

  for (const header of composerData.fullConversationHeadersOnly) {
    const item = bubbles.get(header.bubbleId);
    if (!item) continue;

    const { bubble, json } = item;

    if (bubble.type === 1 && bubbleBelongsToProject(json, projectPath)) {
      belongsToProject = true;
    }

    const timestamp = getTimestampFromBubble(bubble);
    if (!firstTimestamp || timestamp < firstTimestamp) firstTimestamp = timestamp;
    if (!lastTimestamp || timestamp > lastTimestamp) lastTimestamp = timestamp;

    if (bubble.type === 1 && bubble.text) {
      if (!firstUserMessage) firstUserMessage = bubble.text;
      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        timestamp,
        userMessage: bubble.text,
      };
    }

    if (bubble.type === 2 && bubble.text && currentEntry) {
      currentEntry.assistantMessage = currentEntry.assistantMessage
        ? currentEntry.assistantMessage + '\n\n' + bubble.text
        : bubble.text;
    }
  }

  if (currentEntry) entries.push(currentEntry);
  if (!belongsToProject || !firstTimestamp || entries.length === 0) return null;

  return {
    id: composerData.composerId,
    firstUserMessage: firstUserMessage || 'Untitled Session',
    firstTimestamp,
    lastTimestamp: lastTimestamp || firstTimestamp,
    entries,
  };
}

function parseBubbleKey(key: string): { composerId: string; bubbleId: string } | null {
  // bubbleId:composerId:bubbleId
  const match = key.match(/^bubbleId:([^:]+):(.+)$/);
  if (!match) return null;
  return { composerId: match[1], bubbleId: match[2] };
}

export async function copyCursorLogs(
  targetDir: string,
  projectPath: string,
  username: string
): Promise<void> {
  const dbPath = getCursorDbPath();

  if (!(await exists(dbPath))) {
    log('Cursor state database not found');
    return;
  }

  log('Processing Cursor logs...');
  const destDir = path.join(targetDir, 'cursor');
  await ensureDir(destDir);

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    logError('opening Cursor database', e);
    log('   Could not access Cursor database. Make sure Cursor is installed.');
    return;
  }

  try {
    // Get all composer data
    const composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as KVRow[];

    if (composerRows.length === 0) {
      log('   No Cursor conversations found');
      db.close();
      return;
    }

    const composerMap = new Map<string, string>();
    for (const row of composerRows) {
      composerMap.set(row.key, row.value);
    }

    // Get bubbles that contain the project path and find matching composers
    const escapedPath = projectPath.replace(/'/g, "''");
    const initialBubbleRows = db
      .prepare(
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%${escapedPath}%'`
      )
      .all() as KVRow[];

    const matchingComposerIds = new Set<string>();
    let skippedCount = 0;

    // First pass: find composer IDs
    for (const row of initialBubbleRows) {
      const parsed = parseBubbleKey(row.key);
      if (parsed) {
        matchingComposerIds.add(parsed.composerId);
      }
    }

    if (matchingComposerIds.size === 0) {
      log('   No Cursor conversations found for this project');
      db.close();
      return;
    }

    // Single optimized query: get all bubbles for matching composers
    const composerIdPatterns = Array.from(matchingComposerIds)
      .map((id) => `'bubbleId:${id}:%'`)
      .join(' OR key LIKE ');

    const allBubbleRows = db
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ${composerIdPatterns}`)
      .all() as KVRow[];

    const allBubbles = new Map<string, BubbleWithJson>();

    for (const row of allBubbleRows) {
      const parsed = parseBubbleKey(row.key);
      if (!parsed) continue;

      try {
        const parsedBubble = JSON.parse(row.value);
        if (!isValidBubble(parsedBubble)) {
          debug(`Invalid bubble structure: ${row.key}`);
          skippedCount++;
          continue;
        }
        allBubbles.set(`${parsed.composerId}:${parsed.bubbleId}`, { bubble: parsedBubble, json: row.value });
      } catch (e) {
        debug(`Failed to parse bubble JSON: ${(e as Error).message}`);
        skippedCount++;
      }
    }

    if (skippedCount > 0) {
      debug(`Skipped ${skippedCount} invalid bubbles`);
    }

    // Process matching composers
    let processedCount = 0;

    for (const composerId of matchingComposerIds) {
      const composerJson = composerMap.get(`composerData:${composerId}`);
      if (!composerJson) continue;

      try {
        const composerData: ComposerData = JSON.parse(composerJson);

        const composerBubbles = new Map<string, BubbleWithJson>();
        for (const [key, item] of allBubbles) {
          if (key.startsWith(`${composerId}:`)) {
            const bubbleId = key.slice(composerId.length + 1);
            composerBubbles.set(bubbleId, item);
          }
        }

        const session = buildSession(composerBubbles, composerData, projectPath);

        if (session) {
          const markdown = generateMarkdown(session, username, 'Cursor');
          const filename = formatFilename(session.firstTimestamp, session.id, session.firstUserMessage);
          await fs.writeFile(path.join(destDir, filename), markdown);
          processedCount++;
        }
      } catch (e) {
        debug(`Failed to process composer ${composerId}: ${(e as Error).message}`);
      }
    }

    log(`   Processed ${processedCount} sessions`);
  } finally {
    db.close();
  }
}
