import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

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

interface Session {
  id: string;
  summary: string;
  firstTimestamp: Date;
  lastTimestamp: Date;
  entries: SessionEntry[];
}

interface SessionEntry {
  timestamp: Date;
  userMessage?: string;
  assistantMessage?: string;
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
      timeout: 30000, // 30 second timeout for big queries
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large results
    });
  } catch {
    return '';
  }
}

function formatISOLocal(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');

  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offsetH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const offsetM = String(Math.abs(offset) % 60).padStart(2, '0');

  return `${y}-${mo}-${d}T${h}:${min}:${sec}${sign}${offsetH}:${offsetM}`;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function formatFilename(date: Date, composerId: string, summary: string): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const shortId = composerId.slice(0, 8);
  const slug = slugify(summary);
  return slug
    ? `${y}-${m}-${d}_${h}${min}_${slug}_${shortId}.md`
    : `${y}-${m}-${d}_${h}${min}_${shortId}.md`;
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

    // Check if this conversation belongs to the target project
    if (bubble.type === 1 && bubbleBelongsToProject(bubble, projectPath)) {
      belongsToProject = true;
    }

    const timestamp = getTimestampFromBubble(bubble);
    if (!firstTimestamp || timestamp < firstTimestamp) firstTimestamp = timestamp;
    if (!lastTimestamp || timestamp > lastTimestamp) lastTimestamp = timestamp;

    // User message (type 1)
    if (bubble.type === 1 && bubble.text) {
      if (!firstUserMessage) {
        firstUserMessage = bubble.text.slice(0, 60).replace(/\n/g, ' ');
      }
      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        timestamp,
        userMessage: bubble.text,
      };
    }

    // Assistant message (type 2)
    if (bubble.type === 2 && bubble.text && currentEntry) {
      currentEntry.assistantMessage = currentEntry.assistantMessage
        ? currentEntry.assistantMessage + '\n\n' + bubble.text
        : bubble.text;
    }
  }

  if (currentEntry) entries.push(currentEntry);

  if (!belongsToProject || !firstTimestamp || entries.length === 0) return null;

  const summary = firstUserMessage || 'Untitled Session';

  return {
    id: composerData.composerId,
    summary,
    firstTimestamp,
    lastTimestamp: lastTimestamp || firstTimestamp,
    entries,
  };
}

function truncateTitle(text: string, maxLen = 60): string {
  const oneLine = text.split('\n')[0].trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

function generateMarkdown(session: Session, username: string): string {
  const lines: string[] = [];
  const title = truncateTitle(session.summary);

  lines.push(`# Cursor: ${title}`);
  lines.push('');
  lines.push('Tool: Cursor');
  lines.push('');
  lines.push(`User: ${username}`);
  lines.push('');
  lines.push(`Started: ${formatISOLocal(session.firstTimestamp)}`);
  lines.push('');
  lines.push(`Last updated: ${formatISOLocal(session.lastTimestamp)}`);
  lines.push('');
  lines.push(`Session ID: ${session.id}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const entry of session.entries) {
    lines.push(`## ${formatISOLocal(entry.timestamp)}`);
    lines.push('');

    if (entry.userMessage) {
      lines.push('### User');
      lines.push('');
      const quotedUser = entry.userMessage.split('\n').map((line) => `> ${line}`);
      lines.push(...quotedUser);
      lines.push('');
    }

    if (entry.assistantMessage) {
      lines.push('### Assistant');
      lines.push('');
      const quotedAssistant = entry.assistantMessage
        .split('\n')
        .map((line) => `> ${line}`);
      lines.push(...quotedAssistant);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// Parse key-value pairs from sqlite3 output (handles embedded pipes in JSON)
function parseKeyValueOutput(
  output: string,
  keyPrefix: string
): Map<string, string> {
  const result = new Map<string, string>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    // Find the first pipe after the key prefix
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

  // Step 1: Get all composerData in one query
  const composerResult = queryDb(
    dbPath,
    "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
  );

  if (!composerResult.trim()) {
    log('   No Cursor conversations found');
    return;
  }

  const composerMap = parseKeyValueOutput(composerResult, 'composerData:');

  // Step 2: Get all bubbles that might contain project paths
  // We look for bubbles that have the project path in their value
  const escapedPath = projectPath.replace(/'/g, "''");
  const bubbleResult = queryDb(
    dbPath,
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%${escapedPath}%'`
  );

  // Extract composer IDs that have matching bubbles
  const matchingComposerIds = new Set<string>();
  const allBubbles = new Map<string, Bubble>();

  if (bubbleResult.trim()) {
    for (const line of bubbleResult.split('\n')) {
      if (!line.trim()) continue;

      // bubbleId:composerId:bubbleId|json
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

  // Step 3: For matching composers, get ALL their bubbles
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

  // Step 4: Process matching composers
  let processedCount = 0;

  for (const composerId of matchingComposerIds) {
    const composerJson = composerMap.get(`composerData:${composerId}`);
    if (!composerJson) continue;

    try {
      const composerData: ComposerData = JSON.parse(composerJson);

      // Build a bubble map for this composer
      const composerBubbles = new Map<string, Bubble>();
      for (const [key, bubble] of allBubbles) {
        if (key.startsWith(`${composerId}:`)) {
          const bubbleId = key.slice(composerId.length + 1);
          composerBubbles.set(bubbleId, bubble);
        }
      }

      const session = buildSession(composerBubbles, composerData, projectPath);

      if (session) {
        const markdown = generateMarkdown(session, username);
        const filename = formatFilename(session.firstTimestamp, session.id, session.summary);
        await fs.writeFile(path.join(destDir, filename), markdown);
        processedCount++;
      }
    } catch {
      // Skip invalid data
    }
  }

  log(`   Processed ${processedCount} sessions`);
}
