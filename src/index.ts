import fs from 'node:fs/promises';
import path from 'node:path';

import { copyClaudeLogs } from './claude.js';
import { ensureDir, exists, log } from './utils.js';

const OUTPUT_DIR = 'ailog';

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ailog - Collect Claude Code logs for current project

Usage:
  npx ailog [command]

Commands:
  clean       Remove the ailog folder

Options:
  -h, --help  Show this help message

Output:
  Creates ./ailog/ directory with collected logs
`);
    return;
  }

  const projectPath = process.cwd();
  const targetDir = path.join(projectPath, OUTPUT_DIR);

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

  log('🚀 Starting ailog...');
  log(`📂 Project: ${projectPath}`);

  await copyClaudeLogs(targetDir, projectPath);

  log(`✅ Done! Logs saved to ./${OUTPUT_DIR}/`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
