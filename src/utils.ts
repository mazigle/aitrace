import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';

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

export type Platform = 'darwin' | 'linux' | 'win32';

export function getPlatform(): Platform {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  // Fallback for other Unix-like systems
  return 'linux';
}

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

export function getGitUsername(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

export function slugifyPath(str: string): string {
  return str.toLowerCase().trim().replace(/\s+/g, '-');
}

