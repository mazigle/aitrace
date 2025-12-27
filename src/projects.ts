// Project discovery and listing
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeProjectPath, encodeProjectPath, getClaudeProjectsRoot, getCursorDbPath } from './paths.js';
import { debug, exists } from './utils.js';

export interface Project {
  path: string;
  name: string;
  hasClaude: boolean;
  hasCursor: boolean;
  lastActivity: Date;
}

interface KVRow {
  key: string;
  value: string;
}

interface ClaudeProject {
  path: string;
  lastActivity: Date;
}

interface CursorProject {
  path: string;
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
      // Extract timestamp
      const timeMatch = row.value.match(timeRegex);
      const timestamp = timeMatch ? new Date(parseInt(timeMatch[1], 10)) : new Date(0);

      // Extract paths
      let match;
      while ((match = pathRegex.exec(row.value)) !== null) {
        const filePath = match[1];
        const parts = filePath.split('/');
        for (let i = parts.length - 1; i >= 3; i--) {
          const candidate = parts.slice(0, i).join('/');
          if (candidate && !candidate.includes('node_modules')) {
            const existing = projects.get(candidate);
            if (!existing || timestamp > existing.lastActivity) {
              projects.set(candidate, { path: candidate, lastActivity: timestamp });
            }
            break;
          }
        }
      }
    }

    // Also check composerData for workspace paths
    const composerRows = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as { value: string }[];

    const workspaceRegex = /"fsPath"\s*:\s*"([^"]+)"/g;
    for (const row of composerRows) {
      let match;
      while ((match = workspaceRegex.exec(row.value)) !== null) {
        const filePath = match[1];
        const parts = filePath.split('/');
        for (let i = parts.length - 1; i >= 3; i--) {
          const candidate = parts.slice(0, i).join('/');
          if (candidate && !candidate.includes('node_modules')) {
            if (!projects.has(candidate)) {
              projects.set(candidate, { path: candidate, lastActivity: new Date(0) });
            }
            break;
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
  // Check if path is accessible (not SSH remote, etc.)
  if (projectPath.startsWith('ssh://') || projectPath.includes('@')) {
    return false;
  }
  return exists(projectPath);
}
