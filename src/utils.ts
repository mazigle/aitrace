import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

let verboseMode = false;

export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

export function log(msg: string): void {
  console.log(msg);
}

export function debug(msg: string): void {
  if (verboseMode) {
    console.log(`[DEBUG] ${msg}`);
  }
}

export function isVerbose(): boolean {
  return verboseMode;
}

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error in ${context}: ${message}`);
  if (verboseMode) {
    console.error(error);
  }
}

export function getGitUsername(): string {
  // 1. Try repo-specific git config
  try {
    return execSync('git config user.name', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    // Not in a git repo or no local config
  }

  // 2. Try global git config
  try {
    return execSync('git config --global user.name', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    // No global git config
  }

  // 3. Fallback to OS username
  return process.env.USER || process.env.USERNAME || 'unknown';
}

export function slugifyPath(str: string): string {
  return str.toLowerCase().trim().replace(/\s+/g, '-');
}

export function getHostname(): string {
  const hostname = os.hostname();
  // Remove .local, .lan, etc. suffixes and slugify
  return hostname
    .replace(/\.local$|\.lan$|\.home$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getUserIdentifier(): string {
  const username = slugifyPath(getGitUsername());
  const hostname = getHostname();
  return `${username}@${hostname}`;
}

export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function formatDate(date: Date): string {
  // 1970-01-01 (epoch) means no valid timestamp
  if (date.getTime() === 0) {
    return '----------';
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatRemoteInfo(remoteHost: string, path: string): string {
  // Extract username if present in the remote host (e.g., "user@hostname")
  // If not, just use the hostname
  return `${remoteHost}:${path}`;
}
