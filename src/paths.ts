// Centralized path management for all supported tools
import fs from 'node:fs';
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

// Cache for decoded paths
const pathCache = new Map<string, string>();

export function decodeProjectPath(encodedPath: string): string {
  // Check cache first
  const cached = pathCache.get(encodedPath);
  if (cached) return cached;
  // -Users-donghyun-repo-sgr-newsletter -> /Users/donghyun/repo/sgr-newsletter
  // The challenge: both / and - in original path become - in encoded path
  // Solution: Greedily find existing directories from left to right

  const platform = getPlatform();
  const sep = platform === 'win32' ? '\\' : '/';

  if (platform === 'win32') {
    // Check if it looks like a Windows path (starts with -X- where X is a drive letter)
    const winMatch = encodedPath.match(/^-([A-Za-z])-(.*)$/);
    if (winMatch) {
      const [, drive, rest] = winMatch;
      return decodePathSegments(`${drive}:`, rest.split('-').filter(Boolean), sep);
    }
  }

  // Unix path: -Users-donghyun-repo-... -> /Users/donghyun/repo/...
  const segments = encodedPath.split('-').filter(Boolean);
  const result = decodePathSegments('', segments, sep);

  // Cache the result
  pathCache.set(encodedPath, result);
  return result;
}

function decodePathSegments(prefix: string, segments: string[], sep: string): string {
  // Greedily decode: find the shortest segment that exists as a directory,
  // then recurse with remaining segments

  let currentPath = prefix;
  let remaining = [...segments];

  while (remaining.length > 0) {
    let found = false;

    // Try single segment first (most common case)
    for (let len = 1; len <= remaining.length; len++) {
      const segment = remaining.slice(0, len).join('-');
      const testPath = currentPath ? `${currentPath}${sep}${segment}` : `${sep}${segment}`;

      // If this is the last segment(s), just accept it
      if (len === remaining.length) {
        return testPath;
      }

      // Check if this path exists as a directory
      try {
        const stat = fs.statSync(testPath);
        if (stat.isDirectory()) {
          currentPath = testPath;
          remaining = remaining.slice(len);
          found = true;
          break;
        }
      } catch {
        // Path doesn't exist, try longer segment
      }
    }

    // If nothing was found, fallback to single segment
    if (!found) {
      const segment = remaining[0];
      currentPath = currentPath ? `${currentPath}${sep}${segment}` : `${sep}${segment}`;
      remaining = remaining.slice(1);
    }
  }

  return currentPath || sep;
}

