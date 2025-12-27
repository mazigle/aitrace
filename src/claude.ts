import fs from 'node:fs/promises';
import path from 'node:path';

import type { Session, SessionEntry } from './format.js';
import { formatFilename, generateMarkdown } from './format.js';
import { getClaudeProjectDir } from './paths.js';
import { debug, ensureDir, exists, log } from './utils.js';

interface ClaudeMessage {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  timestamp?: string;
  sessionId?: string;
}

function extractTextContent(message: ClaudeMessage['message']): string | null {
  if (!message) return null;
  if (typeof message.content === 'string') {
    return message.content;
  }
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
    } catch (e) {
      debug(`Failed to parse JSON line: ${(e as Error).message}`);
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
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp);
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

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

export async function copyClaudeLogs(
  targetDir: string,
  projectPath: string,
  username: string
): Promise<void> {
  const claudeProjectDir = getClaudeProjectDir(projectPath);
  const destDir = path.join(targetDir, 'claude');

  if (!(await exists(claudeProjectDir))) {
    log(`Claude Code logs not found for: ${projectPath}`);
    return;
  }

  log('Processing Claude Code logs...');
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
        const markdown = generateMarkdown(session, username, 'Claude Code');
        const filename = formatFilename(session.firstTimestamp, session.id, session.firstUserMessage);
        await fs.writeFile(path.join(destDir, filename), markdown);
        processedCount++;
      }
    } catch (e) {
      debug(`Failed to process ${file}: ${(e as Error).message}`);
    }
  }

  log(`   Processed ${processedCount} sessions`);
}
