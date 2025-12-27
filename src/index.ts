import fs from 'node:fs/promises';
import path from 'node:path';

import { copyClaudeLogs } from './claude.js';
import { copyCursorLogs } from './cursor.js';
import { ensureDir, exists, log } from './utils.js';

const OUTPUT_DIR = 'ailog';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ailog - Collect Claude Code and Cursor logs

Usage:
  npx ailog [command] [options]

Commands:
  clean       Remove the ailog folder

Options:
  --claude    Copy only Claude Code logs
  --cursor    Copy only Cursor logs
  -h, --help  Show this help message

Output:
  Creates ./ailog/ directory with collected logs
`);
    return;
  }

  const targetDir = path.join(process.cwd(), OUTPUT_DIR);

  if (args.includes('clean')) {
    if (await exists(targetDir)) {
      await fs.rm(targetDir, { recursive: true });
      log('🧹 Cleaned up ailog folder');
    } else {
      log('ℹ️  No ailog folder to clean');
    }
    return;
  }

  await ensureDir(targetDir);

  const claudeOnly = args.includes('--claude');
  const cursorOnly = args.includes('--cursor');
  const copyAll = !claudeOnly && !cursorOnly;

  log('🚀 Starting ailog...');

  if (copyAll || claudeOnly) {
    await copyClaudeLogs(targetDir);
  }

  if (copyAll || cursorOnly) {
    await copyCursorLogs(targetDir);
  }

  log(`✅ Done! Logs saved to ./${OUTPUT_DIR}/`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

