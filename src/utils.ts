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
