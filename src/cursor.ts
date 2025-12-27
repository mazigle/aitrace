import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { GenerateMarkdownOptions, Session, SessionEntry } from './format.js';
import { formatFilename, generateMarkdown } from './format.js';
import { getCursorDbPath } from './paths.js';
import { debug, ensureDir, exists, log } from './utils.js';

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
  createdAt?: number;
  fullConversationHeadersOnly: Array<{
    bubbleId: string;
    type: number;
  }>;
}

interface KVRow {
  key: string;
  value: string;
}

function getTimestampFromBubble(bubble: Bubble): Date | null {
  if (bubble.timingInfo?.clientRpcSendTime) {
    return new Date(bubble.timingInfo.clientRpcSendTime);
  }
  return null;
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
  // Only require bubbleId and type - text is optional
  return typeof b.bubbleId === 'string' && typeof b.type === 'number';
}

function buildSession(
  bubbles: Map<string, BubbleWithJson>,
  composerData: ComposerData,
  projectPath: string
): Session | null {
  const entries: SessionEntry[] = [];
  // Use composerData.createdAt as the primary timestamp source
  const createdAt = composerData.createdAt ? new Date(composerData.createdAt) : null;
  let firstTimestamp: Date | null = createdAt;
  let lastTimestamp: Date | null = createdAt;
  let belongsToProject = false;
  let firstUserMessage = '';
  let currentEntry: SessionEntry | null = null;

  for (const header of composerData.fullConversationHeadersOnly) {
    const item = bubbles.get(header.bubbleId);
    if (!item) continue;

    const { bubble, json } = item;

    if (bubbleBelongsToProject(json, projectPath)) {
      belongsToProject = true;
    }

    // Only use bubble timestamp if available and valid
    const bubbleTimestamp = getTimestampFromBubble(bubble);
    if (bubbleTimestamp && !isNaN(bubbleTimestamp.getTime())) {
      if (!firstTimestamp || bubbleTimestamp < firstTimestamp) firstTimestamp = bubbleTimestamp;
      if (!lastTimestamp || bubbleTimestamp > lastTimestamp) lastTimestamp = bubbleTimestamp;
    }

    if (bubble.type === 1 && bubble.text) {
      if (!firstUserMessage) firstUserMessage = bubble.text;
      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        timestamp: bubbleTimestamp || createdAt || new Date(),
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

function getCursorSessions(projectPath: string): Session[] {
  const dbPath = getCursorDbPath();
  const sessions: Session[] = [];

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return sessions;
  }

  try {
    // Get all composer data (use >= and < for index optimization)
    const composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'")
      .all() as KVRow[];

    if (composerRows.length === 0) {
      return sessions;
    }

    const composerMap = new Map<string, string>();
    for (const row of composerRows) {
      composerMap.set(row.key, row.value);
    }

    // Get bubbles that contain the project path and find matching composers
    // Use >= and < for index optimization, only fetch key since we just need composer IDs
    const escapedPath = projectPath.replace(/'/g, "''");
    const initialBubbleRows = db
      .prepare(
        `SELECT key FROM cursorDiskKV WHERE key >= 'bubbleId:' AND key < 'bubbleId;' AND value LIKE '%${escapedPath}%'`
      )
      .all() as { key: string }[];

    const matchingComposerIds = new Set<string>();

    for (const row of initialBubbleRows) {
      const parsed = parseBubbleKey(row.key);
      if (parsed) {
        matchingComposerIds.add(parsed.composerId);
      }
    }

    if (matchingComposerIds.size === 0) {
      return sessions;
    }

    // Process each matching composer with individual optimized queries
    for (const composerId of matchingComposerIds) {
      const composerJson = composerMap.get(`composerData:${composerId}`);
      if (!composerJson) continue;

      try {
        const composerData: ComposerData = JSON.parse(composerJson);

        // Get all bubbles for this composer using index-optimized range query
        const bubbleRows = db
          .prepare(`SELECT key, value FROM cursorDiskKV WHERE key >= 'bubbleId:${composerId}:' AND key < 'bubbleId:${composerId};'`)
          .all() as KVRow[];

        const composerBubbles = new Map<string, BubbleWithJson>();
        for (const row of bubbleRows) {
          const parsed = parseBubbleKey(row.key);
          if (!parsed) continue;

          try {
            const parsedBubble = JSON.parse(row.value);
            if (!isValidBubble(parsedBubble)) {
              debug(`Invalid bubble structure: ${row.key}`);
              continue;
            }
            composerBubbles.set(parsed.bubbleId, { bubble: parsedBubble, json: row.value });
          } catch (e) {
            debug(`Failed to parse bubble JSON: ${(e as Error).message}`);
          }
        }

        const session = buildSession(composerBubbles, composerData, projectPath);
        if (session) {
          sessions.push(session);
        }
      } catch (e) {
        debug(`Failed to process composer ${composerId}: ${(e as Error).message}`);
      }
    }
  } finally {
    db.close();
  }

  return sessions;
}

export function countCursorSessions(projectPath: string): number {
  return getCursorSessions(projectPath).length;
}

export async function copyCursorLogs(
  targetDir: string,
  projectPath: string,
  username: string,
  options: GenerateMarkdownOptions = {}
): Promise<void> {
  const dbPath = getCursorDbPath();

  if (!(await exists(dbPath))) {
    log('Cursor state database not found');
    return;
  }

  log('Processing Cursor logs...');
  const destDir = path.join(targetDir, 'cursor');
  await ensureDir(destDir);

  const sessions = getCursorSessions(projectPath);

  if (sessions.length === 0) {
    log('   No Cursor conversations found for this project');
    return;
  }

  for (const session of sessions) {
    const markdown = generateMarkdown(session, username, 'Cursor', options);
    const filename = formatFilename(session.firstTimestamp, session.id, session.firstUserMessage);
    await fs.writeFile(path.join(destDir, filename), markdown);
  }

  log(`   Processed ${sessions.length} sessions`);
}
