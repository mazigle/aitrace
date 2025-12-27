import fs from 'node:fs/promises';
import path from 'node:path';

import { copyClaudeLogs } from './claude.js';
import { copyCursorLogs } from './cursor.js';
import { canAccessPath, isKnownProject, listProjects } from './projects.js';
import {
  ensureDir,
  exists,
  formatDate,
  formatRemoteInfo,
  getGitUsername,
  getUserIdentifier,
  log,
  setVerbose,
} from './utils.js';

const OUTPUT_DIR = 'ailog';
const DEFAULT_LIST_LIMIT = 10;

function printHelp() {
  console.log(`
ailog - Collect Claude Code and Cursor logs

Usage:
  npx ailog [command] [options]

Commands:
  (none)        Dump logs for current project
  list          List available projects
  list --all    List all projects (including remote/missing)
  dump <N>      Dump logs for project N (from list)
  clean         Remove your logs from current directory
  clean --all   Remove all ailog data from current directory

Options:
  -o, --output <path>  Output directory (for dump command)
  -v, --verbose        Show debug output
  -h, --help           Show this help message

Examples:
  npx ailog                    # Dump logs for current project
  npx ailog list               # Show available projects
  npx ailog list --all         # Show all projects including remote
  npx ailog dump 1             # Dump project #1 to its location
  npx ailog dump 1 -o ./logs   # Dump project #1 to ./logs
  npx ailog clean              # Remove your logs only
  npx ailog clean --all        # Remove all logs
`);
}

function printNotInProject() {
  console.log(`
Not in a known project directory.

Usage:
  npx ailog              Run in a project directory to dump logs
  npx ailog list         Show available projects
  npx ailog dump <N>     Dump logs for project N from list
  npx ailog --help       Show all options
`);
}

function shortenPath(fullPath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

async function printProjectList(showAll: boolean) {
  const allProjects = await listProjects();

  if (allProjects.length === 0) {
    log('No projects found in Claude Code or Cursor.');
    return;
  }

  // Expand projects: each tool gets its own line
  const expandedProjects: Array<{
    path: string;
    tool: 'Claude' | 'Cursor';
    lastActivity: Date;
    isRemote: boolean;
    remoteHost?: string;
  }> = [];

  for (const p of allProjects) {
    if (p.hasClaude) {
      expandedProjects.push({
        path: p.path,
        tool: 'Claude',
        lastActivity: p.lastActivity,
        isRemote: p.isRemote,
        remoteHost: p.remoteHost,
      });
    }
    if (p.hasCursor) {
      expandedProjects.push({
        path: p.path,
        tool: 'Cursor',
        lastActivity: p.lastActivity,
        isRemote: p.isRemote,
        remoteHost: p.remoteHost,
      });
    }
  }

  // --all flag controls count limit only
  const displayProjects = showAll ? expandedProjects : expandedProjects.slice(0, DEFAULT_LIST_LIMIT);
  const hasMore = !showAll && expandedProjects.length > DEFAULT_LIST_LIMIT;

  log('Projects:\n');

  const maxIdxWidth = String(displayProjects.length).length;

  for (let i = 0; i < displayProjects.length; i++) {
    const p = displayProjects[i];

    const accessible = await canAccessPath(p.path);
    const idx = String(i + 1).padStart(maxIdxWidth, ' ');
    const dateStr = formatDate(p.lastActivity);

    // For remote projects, show hostname:path format
    // For inaccessible local projects, show (missing)
    let displayPath = shortenPath(p.path);
    let statusTag = '';

    if (!accessible) {
      if (p.isRemote && p.remoteHost) {
        displayPath = formatRemoteInfo(p.remoteHost, p.path);
      } else {
        statusTag = ' (missing)';
      }
    }

    log(`  ${idx}. ${dateStr}  ${displayPath}  [${p.tool}]${statusTag}`);
  }

  if (hasMore) {
    log(`\n  ... ${expandedProjects.length - DEFAULT_LIST_LIMIT} more`);
  }

  log('\nUsage: npx ailog dump <N>');
}

async function dumpProject(projectIndex: number, outputPath?: string) {
  const allProjects = await listProjects();

  // Expand projects: each tool gets its own line (matching the list display)
  const expandedProjects: Array<{
    path: string;
    tool: 'Claude' | 'Cursor';
    isRemote: boolean;
    remoteHost?: string;
  }> = [];

  for (const p of allProjects) {
    if (p.hasClaude) {
      expandedProjects.push({
        path: p.path,
        tool: 'Claude',
        isRemote: p.isRemote,
        remoteHost: p.remoteHost,
      });
    }
    if (p.hasCursor) {
      expandedProjects.push({
        path: p.path,
        tool: 'Cursor',
        isRemote: p.isRemote,
        remoteHost: p.remoteHost,
      });
    }
  }

  if (projectIndex < 1 || projectIndex > expandedProjects.length) {
    console.error(`Error: Invalid project number. Use 1-${expandedProjects.length}`);
    process.exit(1);
  }

  const selectedProject = expandedProjects[projectIndex - 1];

  // Find the original project data
  const project = allProjects.find(p => p.path === selectedProject.path);
  if (!project) {
    console.error(`Error: Project not found`);
    process.exit(1);
  }
  const username = getGitUsername();
  const userIdentifier = getUserIdentifier();

  // Determine output directory
  let baseDir: string;
  const accessible = await canAccessPath(project.path);

  if (outputPath) {
    baseDir = path.resolve(outputPath, OUTPUT_DIR);
  } else if (!accessible && selectedProject.tool === 'Claude') {
    // Claude logs are stored locally, can't dump to remote location
    baseDir = path.join(process.cwd(), OUTPUT_DIR);
    log(`Note: Project is not locally accessible. Dumping to current directory.`);
  } else {
    // Default: dump to project location (works for both local and Cursor remote)
    // Cursor reads from local DB, so we can write to remote path
    baseDir = path.join(project.path, OUTPUT_DIR);
  }

  const userDir = path.join(baseDir, userIdentifier);
  await ensureDir(userDir);

  log('Starting ailog...');
  log(`Project: ${project.path}`);
  log(`Tool: ${selectedProject.tool}`);
  log(`User: ${username}`);
  log(`Output: ${baseDir}/${userIdentifier}/`);

  // Only copy logs for the selected tool
  if (selectedProject.tool === 'Claude') {
    await copyClaudeLogs(userDir, project.path, username);
  } else if (selectedProject.tool === 'Cursor') {
    await copyCursorLogs(userDir, project.path, username);
  }

  log(`Done! Logs saved to ${userDir}`);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  if (args.includes('--verbose') || args.includes('-v')) {
    setVerbose(true);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const showAll = args.includes('--all');

  // Parse --output / -o
  let outputPath: string | undefined;
  const outputIdx = args.findIndex((a) => a === '--output' || a === '-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputPath = args[outputIdx + 1];
  }

  // Get command
  const command = args.find((a) => !a.startsWith('-') && a !== outputPath);

  // Handle commands
  if (command === 'list') {
    await printProjectList(showAll);
    return;
  }

  if (command === 'dump') {
    const numArg = args.find((a) => /^\d+$/.test(a));
    if (!numArg) {
      console.error('Error: dump requires a project number. Use "ailog list" first.');
      process.exit(1);
    }
    await dumpProject(parseInt(numArg, 10), outputPath);
    return;
  }

  if (command === 'clean') {
    const projectPath = process.cwd();
    const baseDir = path.join(projectPath, OUTPUT_DIR);

    if (showAll) {
      // Clean everything
      if (await exists(baseDir)) {
        await fs.rm(baseDir, { recursive: true });
        log('Cleaned up all ailog data');
      } else {
        log('No ailog folder to clean');
      }
    } else {
      // Clean only current user's folder
      const userIdentifier = getUserIdentifier();
      const userDir = path.join(baseDir, userIdentifier);
      if (await exists(userDir)) {
        await fs.rm(userDir, { recursive: true });
        log(`Cleaned up ${userIdentifier}/`);
      } else {
        log(`No logs found for ${userIdentifier}`);
      }
    }
    return;
  }

  // Default: check if current directory is a known project
  const projectPath = process.cwd();
  const isProject = await isKnownProject(projectPath);

  if (!isProject) {
    printNotInProject();
    return;
  }

  // Dump current project
  const username = getGitUsername();
  const userIdentifier = getUserIdentifier();
  const baseDir = path.join(projectPath, OUTPUT_DIR);
  const userDir = path.join(baseDir, userIdentifier);

  await ensureDir(userDir);

  log('Starting ailog...');
  log(`Project: ${projectPath}`);
  log(`User: ${username}`);

  await copyClaudeLogs(userDir, projectPath, username);
  await copyCursorLogs(userDir, projectPath, username);

  log(`Done! Logs saved to ./${OUTPUT_DIR}/${userIdentifier}/`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
