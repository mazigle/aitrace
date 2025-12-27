import fs from 'node:fs/promises';
import path from 'node:path';

import { copyClaudeLogs } from './claude.js';
import { copyCursorLogs } from './cursor.js';
import { canAccessPath, isKnownProject, listProjects } from './projects.js';
import { ensureDir, exists, getGitUsername, getUserIdentifier, log, setVerbose } from './utils.js';

const OUTPUT_DIR = 'ailog';

function printHelp() {
  console.log(`
ailog - Collect Claude Code and Cursor logs

Usage:
  npx ailog [command] [options]

Commands:
  (none)        Dump logs for current project, or list if not a project
  list          List all known projects
  dump <N>      Dump logs for project N (from list)
  clean         Remove your logs from current directory
  clean --all   Remove all ailog data from current directory

Options:
  -o, --output <path>  Output directory (for dump command)
  -v, --verbose        Show debug output
  -h, --help           Show this help message

Examples:
  ailog                    # Dump current project or show list
  ailog list               # Show all projects
  ailog dump 1             # Dump project #1 to its location
  ailog dump 1 -o ./logs   # Dump project #1 to ./logs
  ailog clean              # Remove your logs only
  ailog clean --all        # Remove all logs
`);
}

async function printProjectList() {
  const projects = await listProjects();

  if (projects.length === 0) {
    log('📋 No projects found in Claude Code or Cursor.');
    return;
  }

  log('📋 Available projects:\n');

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const tools: string[] = [];
    if (p.hasClaude) tools.push('Claude');
    if (p.hasCursor) tools.push('Cursor');
    const toolsStr = tools.join(', ');

    const accessible = await canAccessPath(p.path);
    const accessIcon = accessible ? '' : ' (remote)';

    log(`  ${i + 1}. ${p.path}${accessIcon}`);
    log(`     [${toolsStr}]`);
  }

  log('\nUse: ailog dump <N> [-o <path>]');
}

async function dumpProject(projectIndex: number, outputPath?: string) {
  const projects = await listProjects();

  if (projectIndex < 1 || projectIndex > projects.length) {
    console.error(`Error: Invalid project number. Use 1-${projects.length}`);
    process.exit(1);
  }

  const project = projects[projectIndex - 1];
  const username = getGitUsername();
  const userIdentifier = getUserIdentifier();

  // Determine output directory
  let baseDir: string;
  if (outputPath) {
    baseDir = path.resolve(outputPath, OUTPUT_DIR);
  } else {
    // Default: dump to project location
    const accessible = await canAccessPath(project.path);
    if (!accessible) {
      console.error(`Error: Cannot access project path: ${project.path}`);
      console.error('Use --output to specify a local dump location:');
      console.error(`  ailog dump ${projectIndex} --output ./my-logs`);
      process.exit(1);
    }
    baseDir = path.join(project.path, OUTPUT_DIR);
  }

  const userDir = path.join(baseDir, userIdentifier);
  await ensureDir(userDir);

  log('🚀 Starting ailog...');
  log(`📂 Project: ${project.path}`);
  log(`👤 User: ${username}`);
  log(`📁 Output: ${baseDir}/${userIdentifier}/`);

  if (project.hasClaude) {
    await copyClaudeLogs(userDir, project.path, username);
  }
  if (project.hasCursor) {
    await copyCursorLogs(userDir, project.path, username);
  }

  log(`✅ Done! Logs saved to ${userDir}`);
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
    await printProjectList();
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

    if (args.includes('--all')) {
      // Clean everything
      if (await exists(baseDir)) {
        await fs.rm(baseDir, { recursive: true });
        log('🧹 Cleaned up all ailog data');
      } else {
        log('ℹ️  No ailog folder to clean');
      }
    } else {
      // Clean only current user's folder
      const userIdentifier = getUserIdentifier();
      const userDir = path.join(baseDir, userIdentifier);
      if (await exists(userDir)) {
        await fs.rm(userDir, { recursive: true });
        log(`🧹 Cleaned up ${userIdentifier}/`);
      } else {
        log(`ℹ️  No logs found for ${userIdentifier}`);
      }
    }
    return;
  }

  // Default: check if current directory is a known project
  const projectPath = process.cwd();
  const isProject = await isKnownProject(projectPath);

  if (!isProject) {
    // Fallback to list
    await printProjectList();
    return;
  }

  // Dump current project
  const username = getGitUsername();
  const userIdentifier = getUserIdentifier();
  const baseDir = path.join(projectPath, OUTPUT_DIR);
  const userDir = path.join(baseDir, userIdentifier);

  await ensureDir(userDir);

  log('🚀 Starting ailog...');
  log(`📂 Project: ${projectPath}`);
  log(`👤 User: ${username}`);

  await copyClaudeLogs(userDir, projectPath, username);
  await copyCursorLogs(userDir, projectPath, username);

  log(`✅ Done! Logs saved to ./${OUTPUT_DIR}/${userIdentifier}/`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
