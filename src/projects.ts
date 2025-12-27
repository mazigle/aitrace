// Project discovery and listing
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeProjectPath, getClaudeProjectsRoot, getCursorDbPath } from './paths.js';
import { debug, exists, logError } from './utils.js';

export interface Project {
  path: string;
  name: string;
  hasClaude: boolean;
  hasCursor: boolean;
  isRemote: boolean;
  remoteHost?: string;
  lastActivity: Date;
}

interface ClaudeProject {
  path: string;
  lastActivity: Date;
}

interface CursorProject {
  path: string;
  isRemote: boolean;
  remoteHost?: string;
  lastActivity: Date;
}

async function getClaudeProjects(): Promise<Map<string, ClaudeProject>> {
  const projects = new Map<string, ClaudeProject>();
  const claudeRoot = getClaudeProjectsRoot();

  if (!(await exists(claudeRoot))) {
    return projects;
  }

  try {
    const entries = await fs.readdir(claudeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('-')) {
        const projectPath = decodeProjectPath(entry.name);
        const dirPath = path.join(claudeRoot, entry.name);

        // Get last activity from folder mtime
        let lastActivity = new Date(0);
        try {
          const stat = await fs.stat(dirPath);
          lastActivity = stat.mtime;

          // Also check individual jsonl files for more accurate time
          const files = await fs.readdir(dirPath);
          for (const file of files) {
            if (file.endsWith('.jsonl')) {
              const fileStat = await fs.stat(path.join(dirPath, file));
              if (fileStat.mtime > lastActivity) {
                lastActivity = fileStat.mtime;
              }
            }
          }
        } catch {
          // Use default
        }

        projects.set(projectPath, { path: projectPath, lastActivity });
      }
    }
  } catch (e) {
    debug(`Failed to read Claude projects: ${(e as Error).message}`);
  }

  return projects;
}

// Parse URI and extract file path
function parseUri(uri: string): { path: string; isRemote: boolean; remoteHost?: string } | null {
  // Check for SSH remote pattern: vscode-remote://ssh-remote%2B{host}/{path}
  const sshMatch = uri.match(/^vscode-remote:\/\/ssh-remote%2B([^/]+)(.+)$/);
  if (sshMatch) {
    const host = decodeURIComponent(sshMatch[1]);
    return { path: sshMatch[2], isRemote: true, remoteHost: host };
  }

  // Check for other remote patterns (wsl, dev-container, etc.)
  const otherRemoteMatch = uri.match(/^vscode-remote:\/\/([^/]+)(.+)$/);
  if (otherRemoteMatch) {
    const remoteType = otherRemoteMatch[1];
    return { path: otherRemoteMatch[2], isRemote: true, remoteHost: remoteType };
  }

  // Check for file:// URI
  const fileMatch = uri.match(/^file:\/\/(.+)$/);
  if (fileMatch) {
    return { path: fileMatch[1], isRemote: false };
  }

  // Plain path starting with /
  if (uri.startsWith('/')) {
    return { path: uri, isRemote: false };
  }

  return null;
}

// Extract project root from a file path
// Project roots are typically at depth 4-5: /Users/{user}/{repos}/{project} or /home/{user}/{repos}/{project}
function extractProjectRoot(filePath: string): string | null {
  const parts = filePath.split('/').filter(Boolean);

  // Skip system paths, hidden paths, and application paths
  if (
    filePath.includes('/Library/') ||
    filePath.includes('/Applications/') ||
    filePath.includes('/.') ||
    filePath.includes('/node_modules/')
  ) {
    return null;
  }

  // macOS: /Users/{user}/{repos}/{project} -> depth 4 (indices 0-3)
  // Linux: /home/{user}/{repos}/{project} -> depth 4
  // Also handle: /Users/{user}/workspace/{project}, /home/{user}/repo/{project}, etc.

  // Common repo folder names
  const repoFolders = ['repo', 'repos', 'workspace', 'projects', 'code', 'dev', 'work', 'personal'];

  // Look for pattern: /Users|home/{user}/{repoFolder}/{project}
  if (parts.length >= 4 && (parts[0] === 'Users' || parts[0] === 'home')) {
    // Check if parts[2] is a repo folder
    if (repoFolders.includes(parts[2].toLowerCase())) {
      // Project root is at depth 4: /Users/{user}/{repos}/{project}
      return '/' + parts.slice(0, 4).join('/');
    }

    // Otherwise, assume depth 3 is the project: /Users/{user}/{project}
    // But only if it's not a system folder
    if (!['Library', 'Applications', 'Documents', 'Desktop', 'Downloads'].includes(parts[2])) {
      return '/' + parts.slice(0, 3).join('/');
    }
  }

  // Fallback: for other patterns, try to find a reasonable root
  // Look for common project indicators by checking parent directories
  if (parts.length >= 3) {
    return '/' + parts.slice(0, Math.min(4, parts.length)).join('/');
  }

  return null;
}

interface ComposerRow {
  value: string;
}

function getCursorProjects(): Map<string, CursorProject> {
  const projects = new Map<string, CursorProject>();
  const dbPath = getCursorDbPath();

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    logError('opening Cursor database', e);
    return projects;
  }

  try {
    // First, get timestamps from composerData (has createdAt field)
    const composerTimestamps = new Map<string, Date>();
    const composerRows = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as ComposerRow[];

    const createdAtRegex = /"createdAt"\s*:\s*(\d+)/;

    for (const row of composerRows) {
      if (!row.value) continue;

      // Extract createdAt timestamp
      const timeMatch = row.value.match(createdAtRegex);
      const timestamp = timeMatch ? new Date(parseInt(timeMatch[1], 10)) : null;

      // Extract file paths from external URIs (use matchAll to avoid lastIndex issues)
      const externalMatches = row.value.matchAll(/"external"\s*:\s*"([^"]+)"/g);
      for (const match of externalMatches) {
        if (!match[1]) continue;
        const rawUri = match[1];

        // Parse URI to extract path
        const uriInfo = parseUri(rawUri);
        if (!uriInfo) continue;

        const { path: filePath, isRemote, remoteHost } = uriInfo;

        const projectRoot = extractProjectRoot(filePath);
        if (!projectRoot) continue;

        const existing = projects.get(projectRoot);
        const existingTime = existing?.lastActivity.getTime() || 0;
        const newTime = timestamp?.getTime() || 0;

        if (!existing || newTime > existingTime) {
          projects.set(projectRoot, {
            path: projectRoot,
            isRemote: existing?.isRemote || isRemote,
            remoteHost: remoteHost || existing?.remoteHost,
            lastActivity: timestamp || new Date(0),
          });
        } else if (isRemote && !existing.isRemote) {
          existing.isRemote = true;
          if (remoteHost) {
            existing.remoteHost = remoteHost;
          }
        }
      }
    }

    // Also check bubbleId data for additional paths and timestamps
    const bubbleRows = db
      .prepare(
        "SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%attachedFileCodeChunksUris%'"
      )
      .all() as { value: string }[];

    const timeRegex = /"clientRpcSendTime"\s*:\s*(\d+)/;

    for (const row of bubbleRows) {
      if (!row.value) continue;

      const timeMatch = row.value.match(timeRegex);
      const timestamp = timeMatch ? new Date(parseInt(timeMatch[1], 10)) : null;

      // Use matchAll to avoid lastIndex issues with global regex
      const pathMatches = row.value.matchAll(/"path"\s*:\s*"([^"]+)"/g);
      for (const match of pathMatches) {
        if (!match[1]) continue;
        const rawPath = match[1];

        // Parse URI to extract path
        const uriInfo = parseUri(rawPath);
        if (!uriInfo) continue;

        const { path: filePath, isRemote, remoteHost } = uriInfo;

        const projectRoot = extractProjectRoot(filePath);
        if (!projectRoot) continue;

        const existing = projects.get(projectRoot);
        const existingTime = existing?.lastActivity.getTime() || 0;
        const newTime = timestamp?.getTime() || 0;

        if (!existing || newTime > existingTime) {
          projects.set(projectRoot, {
            path: projectRoot,
            isRemote: existing?.isRemote || isRemote,
            remoteHost: remoteHost || existing?.remoteHost,
            lastActivity: timestamp || new Date(0),
          });
        } else if (isRemote && !existing.isRemote) {
          existing.isRemote = true;
          if (remoteHost) {
            existing.remoteHost = remoteHost;
          }
        }
      }
    }
  } catch (e) {
    debug(`Failed to read Cursor projects: ${(e as Error).message}`);
  } finally {
    db.close();
  }

  return projects;
}

export async function listProjects(): Promise<Project[]> {
  const claudeProjects = await getClaudeProjects();
  const cursorProjects = getCursorProjects();

  // Merge all unique paths
  const allPaths = new Set([...claudeProjects.keys(), ...cursorProjects.keys()]);

  const projects: Project[] = [];
  for (const p of allPaths) {
    const claude = claudeProjects.get(p);
    const cursor = cursorProjects.get(p);

    // Determine if this is a remote project
    const isRemote = cursor?.isRemote || false;
    const remoteHost = cursor?.remoteHost;

    // Get the most recent activity from either tool
    let lastActivity = new Date(0);
    if (claude && claude.lastActivity > lastActivity) {
      lastActivity = claude.lastActivity;
    }
    if (cursor && cursor.lastActivity > lastActivity) {
      lastActivity = cursor.lastActivity;
    }

    projects.push({
      path: p,
      name: path.basename(p),
      hasClaude: claudeProjects.has(p),
      hasCursor: cursorProjects.has(p),
      isRemote,
      remoteHost,
      lastActivity,
    });
  }

  // Sort by last activity (most recent first)
  projects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

  return projects;
}

export async function isKnownProject(projectPath: string): Promise<boolean> {
  const claudeProjects = await getClaudeProjects();
  const cursorProjects = getCursorProjects();

  return claudeProjects.has(projectPath) || cursorProjects.has(projectPath);
}

export async function canAccessPath(projectPath: string): Promise<boolean> {
  return exists(projectPath);
}

export interface ExpandedProject {
  path: string;
  tool: 'Claude' | 'Cursor';
  lastActivity: Date;
  isRemote: boolean;
  remoteHost?: string;
}

export function expandProjects(projects: Project[]): ExpandedProject[] {
  const expanded: ExpandedProject[] = [];
  for (const p of projects) {
    if (p.hasClaude) {
      expanded.push({
        path: p.path,
        tool: 'Claude',
        lastActivity: p.lastActivity,
        isRemote: p.isRemote,
        remoteHost: p.remoteHost,
      });
    }
    if (p.hasCursor) {
      expanded.push({
        path: p.path,
        tool: 'Cursor',
        lastActivity: p.lastActivity,
        isRemote: p.isRemote,
        remoteHost: p.remoteHost,
      });
    }
  }
  return expanded;
}
