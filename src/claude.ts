import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, exists, getHomeDir, log } from './utils.js';

interface ClaudeMessage {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  timestamp?: string;
  sessionId?: string;
}

interface Session {
  id: string;
  firstUserMessage: string;
  firstTimestamp: Date;
  lastTimestamp: Date;
  entries: SessionEntry[];
}

interface SessionEntry {
  timestamp: Date;
  userMessage?: string;
  assistantMessage?: string;
}

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
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

function formatFilename(date: Date, sessionId: string, summary: string): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const shortId = sessionId.slice(0, 8);
  const slug = slugify(summary);
  return slug
    ? `${y}-${m}-${d}_${h}${min}_${slug}_${shortId}.md`
    : `${y}-${m}-${d}_${h}${min}_${shortId}.md`;
}

function extractTextContent(message: ClaudeMessage['message']): string | null {
  if (!message) return null;
  if (typeof message.content === 'string') {
    return message.content;
  }
  // Array format - extract only text parts (not tool_use)
  const texts = message.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

async function parseJsonlFile(filePath: string): Promise<ClaudeMessage[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const messages: ClaudeMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip invalid JSON lines
    }
  }
  return messages;
}

function buildSession(messages: ClaudeMessage[], sessionId: string): Session | null {
  const entries: SessionEntry[] = [];
  let firstUserMessage = '';
  let firstTimestamp: Date | null = null;
  let lastTimestamp: Date | null = null;

  let currentEntry: SessionEntry | null = null;

  for (const msg of messages) {
    // Track timestamps
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp);
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

    // User message - starts a new entry
    if (msg.type === 'user' && msg.message?.role === 'user') {
      const content = extractTextContent(msg.message);
      if (content && msg.timestamp) {
        if (!firstUserMessage) firstUserMessage = content;
        if (currentEntry) entries.push(currentEntry);
        currentEntry = {
          timestamp: new Date(msg.timestamp),
          userMessage: content,
        };
      }
    }

    // Assistant message - add to current entry
    if (msg.type === 'assistant' && msg.message?.role === 'assistant' && currentEntry) {
      const text = extractTextContent(msg.message);
      if (text) {
        currentEntry.assistantMessage = currentEntry.assistantMessage
          ? currentEntry.assistantMessage + '\n\n' + text
          : text;
      }
    }
  }

  if (currentEntry) entries.push(currentEntry);
  if (!firstTimestamp || entries.length === 0) return null;

  return {
    id: sessionId,
    firstUserMessage: firstUserMessage || 'Untitled Session',
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
  const title = truncateTitle(session.firstUserMessage);

  lines.push(`# Claude Code: ${title}`);
  lines.push('');
  lines.push('Tool: Claude Code');
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
      const quotedUser = entry.userMessage
        .split('\n')
        .map((line) => `> ${line}`);
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

export async function copyClaudeLogs(
  targetDir: string,
  projectPath: string,
  username: string
): Promise<void> {
  const homeDir = getHomeDir();
  const encodedPath = encodeProjectPath(projectPath);

  const claudeProjectDir = path.join(
    homeDir,
    '.claude',
    'projects',
    encodedPath
  );
  const destDir = path.join(targetDir, 'claude');

  if (!(await exists(claudeProjectDir))) {
    log(`⚠️  Claude Code logs not found for: ${projectPath}`);
    return;
  }

  log('📋 Processing Claude Code logs...');
  await ensureDir(destDir);

  const files = await fs.readdir(claudeProjectDir);
  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

  let processedCount = 0;

  for (const file of jsonlFiles) {
    const filePath = path.join(claudeProjectDir, file);
    const sessionId = path.basename(file, '.jsonl');

    try {
      const messages = await parseJsonlFile(filePath);
      const session = buildSession(messages, sessionId);

      if (session) {
        const markdown = generateMarkdown(session, username);
        const filename = formatFilename(session.firstTimestamp, session.id, session.firstUserMessage);
        await fs.writeFile(path.join(destDir, filename), markdown);
        processedCount++;
      }
    } catch {
      // Skip files that can't be processed
    }
  }

  log(`   Processed ${processedCount} sessions`);
}
