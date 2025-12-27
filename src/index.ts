import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { copyClaudeLogs, countClaudeSessions } from './claude.js';
import { copyCursorLogs, countCursorSessions } from './cursor.js';
import { canAccessPath, expandProjects, isKnownProject, listProjects } from './projects.js';
import {
  ensureDir,
  exists,
  formatDate,
  formatRemoteInfo,
  getGitUsername,
  getUserIdentifier,
  log,
  logError,
  scpUpload,
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
  -c, --count          Show session counts in list
  -u, --user-only      Include only user messages (default: full conversation)
  -v, --verbose        Show debug output
  -h, --help           Show this help message

Examples:
  npx ailog                    # Dump logs for current project
  npx ailog list               # Show available projects
  npx ailog list --all         # Show all projects including remote
  npx ailog list --count       # Show projects with session counts
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

async function printProjectList(showAll: boolean, showCount: boolean) {
  const allProjects = await listProjects();

  if (allProjects.length === 0) {
    log('No projects found in Claude Code or Cursor.');
    return;
  }

  const expandedProjects = expandProjects(allProjects);

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

    // Get session count if requested
    let sessionInfo = '';
    if (showCount) {
      let sessionCount = 0;
      if (p.tool === 'Claude') {
        sessionCount = await countClaudeSessions(p.path);
      } else if (p.tool === 'Cursor') {
        sessionCount = countCursorSessions(p.path);
      }
      sessionInfo = ` (${sessionCount})`;
    }

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

    log(`  ${idx}. ${dateStr}  ${displayPath}  [${p.tool}]${sessionInfo}${statusTag}`);
  }

  if (hasMore) {
    log(`\n  ... ${expandedProjects.length - DEFAULT_LIST_LIMIT} more`);
  }

  log('\nUsage: npx ailog dump <N>');
}

async function dumpProject(projectIndex: number, outputPath?: string, options: { includeAssistant?: boolean } = {}) {
  const allProjects = await listProjects();
  const expandedProjects = expandProjects(allProjects);

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

  // Determine output directory and remote target
  let baseDir: string;
  let isRemote = false;
  let remoteTarget: string | undefined;

  if (outputPath) {
    baseDir = path.resolve(outputPath, OUTPUT_DIR);
  } else if (selectedProject.isRemote && selectedProject.tool === 'Cursor') {
    // For remote Cursor: use temp directory, then scp to remote
    baseDir = path.join(os.tmpdir(), 'ailog-temp', userIdentifier);
    isRemote = true;
    remoteTarget = `${selectedProject.remoteHost}:${project.path}/${OUTPUT_DIR}/${userIdentifier}/`;
  } else {
    // Local project or Claude (always local)
    baseDir = path.join(project.path, OUTPUT_DIR);
  }

  const userDir = path.join(baseDir, userIdentifier);
  await ensureDir(userDir);

  log('Starting ailog...');
  log(`Project: ${project.path}`);
  log(`Tool: ${selectedProject.tool}`);
  log(`User: ${username}`);

  if (isRemote && remoteTarget) {
    log(`Output: ${remoteTarget} (via scp)`);
  } else {
    log(`Output: ${baseDir}/${userIdentifier}/`);
  }

  // Only copy logs for the selected tool
  if (selectedProject.tool === 'Claude') {
    await copyClaudeLogs(userDir, project.path, username, options);
  } else if (selectedProject.tool === 'Cursor') {
    await copyCursorLogs(userDir, project.path, username, options);
  }

  // Upload to remote if needed
  if (isRemote && remoteTarget) {
    log('Uploading to remote server...');
    try {
      scpUpload(userDir, remoteTarget);
      // Clean up temp directory
      await fs.rm(baseDir, { recursive: true });
      log(`Done! Logs uploaded to ${remoteTarget}`);
    } catch (e) {
      logError('remote upload', e);
      log(`Failed to upload. Logs are available locally at ${userDir}`);
    }
  } else {
    log(`Done! Logs saved to ${userDir}`);
  }
}

const VALID_FLAGS = ['--verbose', '-v', '--help', '-h', '--all', '--count', '-c', '--output', '-o', '--user-only', '-u'];
const VALID_COMMANDS = ['list', 'dump', 'clean'];

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
  const showCount = args.includes('--count') || args.includes('-c');
  const userOnly = args.includes('--user-only') || args.includes('-u');
  const markdownOptions = { includeAssistant: !userOnly };

  // Parse --output / -o
  let outputPath: string | undefined;
  const outputIdx = args.findIndex((a) => a === '--output' || a === '-o');
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    outputPath = args[outputIdx + 1];
  }

  // Validate unknown flags
  for (const arg of args) {
    if (arg.startsWith('-') && !VALID_FLAGS.includes(arg) && arg !== outputPath) {
      console.error(`Error: Unknown option '${arg}'`);
      console.error('Use --help to see available options.');
      process.exit(1);
    }
  }

  // Get command
  const command = args.find((a) => !a.startsWith('-') && a !== outputPath && !/^\d+$/.test(a));

  // Validate unknown commands
  if (command && !VALID_COMMANDS.includes(command)) {
    console.error(`Error: Unknown command '${command}'`);
    console.error('Use --help to see available commands.');
    process.exit(1);
  }

  // Handle commands
  if (command === 'list') {
    await printProjectList(showAll, showCount);
    return;
  }

  if (command === 'dump') {
    const numArg = args.find((a) => /^\d+$/.test(a));
    if (!numArg) {
      console.error('Error: dump requires a project number. Use "ailog list" first.');
      process.exit(1);
    }
    await dumpProject(parseInt(numArg, 10), outputPath, markdownOptions);
    return;
  }

  if (command === 'clean') {
    const projectPath = process.cwd();
    const baseDir = path.join(projectPath, OUTPUT_DIR);

    if (showAll) {
      // Clean everything
      if (await exists(baseDir)) {
        try {
          await fs.rm(baseDir, { recursive: true });
          log('Cleaned up all ailog data');
        } catch (e) {
          logError('cleaning ailog directory', e);
          process.exit(1);
        }
      } else {
        log('No ailog folder to clean');
      }
    } else {
      // Clean only current user's folder
      const userIdentifier = getUserIdentifier();
      const userDir = path.join(baseDir, userIdentifier);
      if (await exists(userDir)) {
        try {
          await fs.rm(userDir, { recursive: true });
          log(`Cleaned up ${userIdentifier}/`);
        } catch (e) {
          logError('cleaning user directory', e);
          process.exit(1);
        }
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

  await copyClaudeLogs(userDir, projectPath, username, markdownOptions);
  await copyCursorLogs(userDir, projectPath, username, markdownOptions);

  log(`Done! Logs saved to ./${OUTPUT_DIR}/${userIdentifier}/`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
