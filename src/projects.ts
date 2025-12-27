// Project discovery and listing
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { decodeProjectPath, getClaudeProjectsRoot, getCursorDbPath } from './paths.js';
import { debug, exists } from './utils.js';

export interface Project {
  path: string;
  hasClaude: boolean;
  hasCursor: boolean;
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

  try {
    // Query for all unique project paths from bubbles that have file attachments
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT DISTINCT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%attachedFileCodeChunksUris%'" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }
    );

    // Extract unique project roots from file paths
    const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = pathRegex.exec(result)) !== null) {
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
  } catch (e) {
    debug(`Failed to read Cursor projects: ${(e as Error).message}`);
  }

  // Also get from composerData workspace paths if available
  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024 }
    );

    // Look for workspace paths in composer data
    const workspaceRegex = /"fsPath"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = workspaceRegex.exec(result)) !== null) {
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
  } catch {
    // Ignore errors
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

