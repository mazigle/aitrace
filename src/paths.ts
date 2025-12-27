// Centralized path management for all supported tools
import path from 'node:path';

export type Platform = 'darwin' | 'linux' | 'win32';

export function getPlatform(): Platform {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
}

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

export function encodeProjectPath(projectPath: string): string {
  // Handle both Unix (/) and Windows (\) path separators
  return projectPath.replace(/[/\\]/g, '-');
}

export function getCursorDbPath(): string {
  const homeDir = getHomeDir();
  const platform = getPlatform();

  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(process.env.APPDATA || homeDir, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

export function getClaudeProjectDir(projectPath: string): string {
  const homeDir = getHomeDir();
  const encodedPath = encodeProjectPath(projectPath);
  return path.join(homeDir, '.claude', 'projects', encodedPath);
}

