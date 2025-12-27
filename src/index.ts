import fs from 'node:fs/promises';
import path from 'node:path';

import { copyClaudeLogs } from './claude.js';
import { copyCursorLogs } from './cursor.js';
import { ensureDir, exists, getGitUsername, log, setVerbose, slugifyPath } from './utils.js';

const OUTPUT_DIR = 'ailog';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--verbose') || args.includes('-v')) {
    setVerbose(true);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ailog - Collect Claude Code and Cursor logs for current project

Usage:
  npx ailog [command]

Commands:
  clean         Remove the ailog folder

Options:
  -v, --verbose Show debug output
  -h, --help    Show this help message

Output:
  Creates ./ailog/ directory with collected logs
`);
    return;
  }

  const projectPath = process.cwd();
  const username = getGitUsername();
  const userSlug = slugifyPath(username);
  const baseDir = path.join(projectPath, OUTPUT_DIR);
  const userDir = path.join(baseDir, userSlug);

  if (args.includes('clean')) {
    if (await exists(baseDir)) {
      await fs.rm(baseDir, { recursive: true });
      log('🧹 Cleaned up ailog folder');
    } else {
      log('ℹ️  No ailog folder to clean');
    }
    return;
  }

  await ensureDir(userDir);

  log('🚀 Starting ailog...');
  log(`📂 Project: ${projectPath}`);
  log(`👤 User: ${username}`);

  await copyClaudeLogs(userDir, projectPath, username);
  await copyCursorLogs(userDir, projectPath, username);

  log(`✅ Done! Logs saved to ./${OUTPUT_DIR}/${userSlug}/`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
