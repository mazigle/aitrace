// Shared formatting utilities for Claude and Cursor log processors

export interface Session {
  id: string;
  firstUserMessage: string;
  firstTimestamp: Date;
  lastTimestamp: Date;
  entries: SessionEntry[];
}

export interface SessionEntry {
  timestamp: Date;
  userMessage?: string;
  assistantMessage?: string;
}

export function formatISOLocal(date: Date): string {
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

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

export function formatFilename(date: Date, sessionId: string, firstMessage: string): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const shortId = sessionId.slice(0, 8);
  const slug = slugify(firstMessage);
  return slug
    ? `${y}-${m}-${d}-${h}${min}-${slug}-${shortId}.md`
    : `${y}-${m}-${d}-${h}${min}-${shortId}.md`;
}

export function truncateTitle(text: string, maxLen = 60): string {
  const oneLine = text.split('\n')[0].trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

export interface GenerateMarkdownOptions {
  includeAssistant?: boolean;
}

export function generateMarkdown(
  session: Session,
  username: string,
  toolName: string,
  options: GenerateMarkdownOptions = {}
): string {
  const { includeAssistant = false } = options;
  const lines: string[] = [];
  const title = truncateTitle(session.firstUserMessage);

  lines.push(`# ${toolName}: ${title}`);
  lines.push('');
  lines.push(`Tool: ${toolName}`);
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

    if (includeAssistant && entry.assistantMessage) {
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

