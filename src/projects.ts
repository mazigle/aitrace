// Project discovery and listing
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';

import { decodeProjectPath, getClaudeProjectsRoot, getCursorDbPath } from './paths.js';
import { debug, exists } from './utils.js';

export interface Project {
  path: string;
  hasClaude: boolean;
  hasCursor: boolean;
}

interface KVRow {
  key: string;
  value: string;
}

async function getClaudeProjects(): Promise<Set<string>> {
  const projects = new Set<string>();
  const claudeRoot = getClaudeProjectsRoot();

  if (!(await exists(claudeRoot))) {
    return projects;
  }

  try {
    const entries = await fs.readdir(claudeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('-')) {
        const projectPath = decodeProjectPath(entry.name);
        projects.add(projectPath);
      }
    }
  } catch (e) {
    debug(`Failed to read Claude projects: ${(e as Error).message}`);
  }

  return projects;
}

function getCursorProjects(): Set<string> {
  const projects = new Set<string>();
  const dbPath = getCursorDbPath();

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    debug(`Failed to open Cursor database: ${(e as Error).message}`);
    return projects;
  }

  try {
    // Query for all unique project paths from bubbles that have file attachments
    const bubbleRows = db
      .prepare(
        "SELECT DISTINCT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%attachedFileCodeChunksUris%'"
      )
      .all() as { value: string }[];

    // Extract unique project roots from file paths
    const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
    for (const row of bubbleRows) {
      let match;
      while ((match = pathRegex.exec(row.value)) !== null) {
        const filePath = match[1];
        // Extract project root (assume it's up to a common depth)
        // e.g., /Users/donghyun/repo/project/src/file.ts -> /Users/donghyun/repo/project
        const parts = filePath.split('/');
        // Find likely project root (where common dirs like src, lib, node_modules would be)
        for (let i = parts.length - 1; i >= 3; i--) {
          const candidate = parts.slice(0, i).join('/');
          if (candidate && !candidate.includes('node_modules')) {
            projects.add(candidate);
            break;
          }
        }
      }
    }

    // Also get from composerData workspace paths if available
    const composerRows = db
      .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as { value: string }[];

    // Look for workspace paths in composer data
    const workspaceRegex = /"fsPath"\s*:\s*"([^"]+)"/g;
    for (const row of composerRows) {
      let match;
      while ((match = workspaceRegex.exec(row.value)) !== null) {
        const filePath = match[1];
        const parts = filePath.split('/');
        for (let i = parts.length - 1; i >= 3; i--) {
          const candidate = parts.slice(0, i).join('/');
          if (candidate && !candidate.includes('node_modules')) {
            projects.add(candidate);
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
  const allPaths = new Set([...claudeProjects, ...cursorProjects]);

  const projects: Project[] = [];
  for (const path of allPaths) {
    projects.push({
      path,
      hasClaude: claudeProjects.has(path),
      hasCursor: cursorProjects.has(path),
    });
  }

  // Sort by path
  projects.sort((a, b) => a.path.localeCompare(b.path));

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
