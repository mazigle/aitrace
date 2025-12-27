import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Session, SessionEntry } from './format.js';
import { formatFilename, generateMarkdown } from './format.js';
import { ensureDir, exists, getHomeDir, log } from './utils.js';

interface Bubble {
  type: number; // 1 = user, 2 = assistant
  text?: string;
  bubbleId: string;
  attachedFileCodeChunksUris?: Array<{ path: string }>;
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

function getStateDbPath(): string {
  const homeDir = getHomeDir();
  return path.join(
    homeDir,
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb'
  );
}

function queryDb(dbPath: string, sql: string): string {
  try {
    return execSync(`sqlite3 "${dbPath}" "${sql}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function getTimestampFromBubble(bubble: Bubble): Date {
  if (bubble.timingInfo?.clientRpcSendTime) {
    return new Date(bubble.timingInfo.clientRpcSendTime);
  }
  return new Date();
}

function bubbleBelongsToProject(bubble: Bubble, projectPath: string): boolean {
  if (!bubble.attachedFileCodeChunksUris?.length) return false;
  return bubble.attachedFileCodeChunksUris.some((uri) =>
    uri.path?.startsWith(projectPath)
  );
}

function buildSession(
  bubbles: Map<string, Bubble>,
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
    const bubble = bubbles.get(header.bubbleId);
    if (!bubble) continue;

    if (bubble.type === 1 && bubbleBelongsToProject(bubble, projectPath)) {
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

function parseKeyValueOutput(output: string, keyPrefix: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    const prefixEnd = line.indexOf(keyPrefix) + keyPrefix.length;
    const keyEnd = line.indexOf('|', prefixEnd);
    if (keyEnd === -1) continue;

    const key = line.slice(0, keyEnd);
    const value = line.slice(keyEnd + 1);
    result.set(key, value);
  }

  return result;
}

export async function copyCursorLogs(
  targetDir: string,
  projectPath: string,
  username: string
): Promise<void> {
  const dbPath = getStateDbPath();

  if (!(await exists(dbPath))) {
    log('⚠️  Cursor state database not found');
    return;
  }

  log('📋 Processing Cursor logs...');
  const destDir = path.join(targetDir, 'cursor');
  await ensureDir(destDir);

  const composerResult = queryDb(
    dbPath,
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
  );

  if (!composerResult.trim()) {
    log('   No Cursor conversations found');
    return;
  }

  const composerMap = parseKeyValueOutput(composerResult, 'composerData:');

  const escapedPath = projectPath.replace(/'/g, "''");
  const bubbleResult = queryDb(
    dbPath,
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%${escapedPath}%'`
  );

  const matchingComposerIds = new Set<string>();
  const allBubbles = new Map<string, Bubble>();

  if (bubbleResult.trim()) {
    for (const line of bubbleResult.split('\n')) {
      if (!line.trim()) continue;

      const match = line.match(/^bubbleId:([^:]+):([^|]+)\|(.+)$/);
      if (!match) continue;

      const [, composerId, bubbleId, json] = match;
      matchingComposerIds.add(composerId);

      try {
        allBubbles.set(`${composerId}:${bubbleId}`, JSON.parse(json));
      } catch {
        // Skip invalid JSON
      }
    }
  }

  if (matchingComposerIds.size === 0) {
    log('   No Cursor conversations found for this project');
    return;
  }

  for (const composerId of matchingComposerIds) {
    const bubblesResult = queryDb(
      dbPath,
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${composerId}:%'`
    );

    if (!bubblesResult.trim()) continue;

    for (const line of bubblesResult.split('\n')) {
      if (!line.trim()) continue;

      const match = line.match(/^bubbleId:([^:]+):([^|]+)\|(.+)$/);
      if (!match) continue;

      const [, cId, bubbleId, json] = match;
      const key = `${cId}:${bubbleId}`;

      if (!allBubbles.has(key)) {
        try {
          allBubbles.set(key, JSON.parse(json));
        } catch {
          // Skip
        }
      }
    }
  }

  let processedCount = 0;

  for (const composerId of matchingComposerIds) {
    const composerJson = composerMap.get(`composerData:${composerId}`);
    if (!composerJson) continue;

    try {
      const composerData: ComposerData = JSON.parse(composerJson);

      const composerBubbles = new Map<string, Bubble>();
      for (const [key, bubble] of allBubbles) {
        if (key.startsWith(`${composerId}:`)) {
          const bubbleId = key.slice(composerId.length + 1);
          composerBubbles.set(bubbleId, bubble);
        }
      }

      const session = buildSession(composerBubbles, composerData, projectPath);

      if (session) {
        const markdown = generateMarkdown(session, username, 'Cursor');
        const filename = formatFilename(session.firstTimestamp, session.id, session.firstUserMessage);
        await fs.writeFile(path.join(destDir, filename), markdown);
        processedCount++;
      }
    } catch {
      // Skip invalid data
    }
  }

  log(`   Processed ${processedCount} sessions`);
}
