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

export function getClaudeProjectsRoot(): string {
  const homeDir = getHomeDir();
  return path.join(homeDir, '.claude', 'projects');
}

export function decodeProjectPath(encodedPath: string): string {
  // -Users-donghyun-repo-ailog -> /Users/donghyun/repo/ailog
  // Handle Windows: -C--Users-... -> C:\Users\...
  const platform = getPlatform();

  if (platform === 'win32') {
    // Check if it looks like a Windows path (starts with -X- where X is a drive letter)
    const winMatch = encodedPath.match(/^-([A-Za-z])-(.*)$/);
    if (winMatch) {
      const [, drive, rest] = winMatch;
      return `${drive}:${rest.replace(/-/g, '\\')}`;
    }
  }

  // Unix path: -Users-donghyun-... -> /Users/donghyun/...
  return encodedPath.replace(/-/g, '/');
}

