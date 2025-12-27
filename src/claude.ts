import path from 'path';
import { copyDir, exists, getHomeDir, log } from './utils.js';

export async function copyClaudeLogs(targetDir: string): Promise<void> {
  const homeDir = getHomeDir();

  // Claude Code stores logs in ~/.claude/
  const claudeDir = path.join(homeDir, '.claude');
  const destDir = path.join(targetDir, 'claude');

  if (!(await exists(claudeDir))) {
    log('⚠️  Claude Code logs not found');
    return;
  }

  log('📋 Copying Claude Code logs...');
  await copyDir(claudeDir, destDir);
  log('   Claude Code logs copied');
}

