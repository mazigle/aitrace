// Project discovery and listing
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeProjectPath, getClaudeProjectsRoot, getCursorDbPath } from './paths.js';
import { debug, exists } from './utils.js';

export interface Project {
  path: string;
  name: string;
  hasClaude: boolean;
  hasCursor: boolean;
  isRemote: boolean;
  lastActivity: Date;
}

interface ClaudeProject {
  path: string;
  lastActivity: Date;
}

interface CursorProject {
  path: string;
  isRemote: boolean;
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

// Parse vscode-remote URI: vscode-remote://ssh-remote%2B{host}/{path}
function parseVscodeRemoteUri(uri: string): { path: string; isRemote: boolean } | null {
  // Check for SSH remote pattern
  const sshMatch = uri.match(/^vscode-remote:\/\/ssh-remote%2B[^/]+(.+)$/);
  if (sshMatch) {
    return { path: sshMatch[1], isRemote: true };
  }

  // Check for other remote patterns (wsl, dev-container, etc.)
  const otherRemoteMatch = uri.match(/^vscode-remote:\/\/[^/]+(.+)$/);
  if (otherRemoteMatch) {
    return { path: otherRemoteMatch[1], isRemote: true };
  }

  return null;
}

// Extract project root from a file path
function extractProjectRoot(filePath: string): string | null {
  const parts = filePath.split('/');
  for (let i = parts.length - 1; i >= 3; i--) {
    const candidate = parts.slice(0, i).join('/');
    if (candidate && !candidate.includes('node_modules')) {
      return candidate;
    }
  }
  return null;
}

function getCursorProjects(): Map<string, CursorProject> {
  const projects = new Map<string, CursorProject>();
  const dbPath = getCursorDbPath();

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    debug(`Failed to open Cursor database: ${(e as Error).message}`);
    return projects;
  }

  try {
    // Query for bubbles with file attachments and timing info
    const bubbleRows = db
      .prepare(
        "SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%attachedFileCodeChunksUris%'"
      )
      .all() as { value: string }[];

    const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
    const timeRegex = /"clientRpcSendTime"\s*:\s*(\d+)/;

    for (const row of bubbleRows) {
      const timeMatch = row.value.match(timeRegex);
      const timestamp = timeMatch ? new Date(parseInt(timeMatch[1], 10)) : new Date(0);

      let match;
      while ((match = pathRegex.exec(row.value)) !== null) {
        const rawPath = match[1];
        let filePath = rawPath;
        let isRemote = false;

        // Check if it's a vscode-remote URI
        const remoteInfo = parseVscodeRemoteUri(rawPath);
        if (remoteInfo) {
          filePath = remoteInfo.path;
          isRemote = remoteInfo.isRemote;
        }

        const projectRoot = extractProjectRoot(filePath);
        if (projectRoot) {
          const existing = projects.get(projectRoot);
          if (!existing || timestamp > existing.lastActivity) {
            projects.set(projectRoot, {
              path: projectRoot,
              isRemote: existing?.isRemote || isRemote,
              lastActivity: timestamp,
            });
          } else if (isRemote && !existing.isRemote) {
            // If we found a remote reference, mark it as remote
            existing.isRemote = true;
          }
        }
      }
    }

    // Also check composerData for workspace paths and remote URIs
    const composerRows = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as { value: string }[];

    // Look for various URI patterns in workspace data
    const externalRegex = /"external"\s*:\s*"([^"]+)"/g;
    const folderRegex = /"folder"\s*:\s*"([^"]+)"/g;
    const fsPathRegex = /"fsPath"\s*:\s*"([^"]+)"/g;

    for (const row of composerRows) {
      let match;

      // Check external URIs (can contain vscode-remote://)
      while ((match = externalRegex.exec(row.value)) !== null) {
        const rawUri = match[1];
        const remoteInfo = parseVscodeRemoteUri(rawUri);

        if (remoteInfo) {
          const projectRoot = extractProjectRoot(remoteInfo.path);
          if (projectRoot) {
            const existing = projects.get(projectRoot);
            if (!existing) {
              projects.set(projectRoot, {
                path: projectRoot,
                isRemote: true,
                lastActivity: new Date(0),
              });
            } else {
              existing.isRemote = true;
            }
          }
        }
      }

      // Check folder URIs (can also contain vscode-remote://)
      while ((match = folderRegex.exec(row.value)) !== null) {
        const rawUri = match[1];
        const remoteInfo = parseVscodeRemoteUri(rawUri);

        if (remoteInfo) {
          const projectRoot = extractProjectRoot(remoteInfo.path);
          if (projectRoot) {
            const existing = projects.get(projectRoot);
            if (!existing) {
              projects.set(projectRoot, {
                path: projectRoot,
                isRemote: true,
                lastActivity: new Date(0),
              });
            } else {
              existing.isRemote = true;
            }
          }
        }
      }

      // Check fsPath (local paths)
      while ((match = fsPathRegex.exec(row.value)) !== null) {
        const filePath = match[1];
        const projectRoot = extractProjectRoot(filePath);
        if (projectRoot && !projects.has(projectRoot)) {
          projects.set(projectRoot, {
            path: projectRoot,
            isRemote: false,
            lastActivity: new Date(0),
          });
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

export interface ListProjectsOptions {
  includeInaccessible?: boolean;
}

export async function listProjects(options: ListProjectsOptions = {}): Promise<Project[]> {
  const { includeInaccessible = false } = options;

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

    // Filter out inaccessible paths unless explicitly requested
    if (!includeInaccessible) {
      const accessible = await exists(p);
      if (!accessible && !isRemote) continue; // Skip missing local projects
      if (!accessible) continue; // Skip remote projects too in default view
    }

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
