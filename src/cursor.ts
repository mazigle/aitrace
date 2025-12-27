import path from 'path';
import { copyDir, exists, getHomeDir, log } from './utils.js';

export async function copyCursorLogs(targetDir: string): Promise<void> {
  const homeDir = getHomeDir();

  // Cursor logs location varies by OS
  const cursorPaths = [
    path.join(homeDir, '.cursor'),
    path.join(homeDir, 'Library', 'Application Support', 'Cursor'),
  ];

  const destDir = path.join(targetDir, 'cursor');

  for (const cursorDir of cursorPaths) {
    if (!(await exists(cursorDir))) continue;

    log('📋 Copying Cursor logs...');
    await copyDir(cursorDir, destDir);
    log('   Cursor logs copied');
    return;
  }

  log('⚠️  Cursor logs not found');
}

