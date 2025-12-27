import path from 'node:path';

import { copyDir, exists, getHomeDir, log } from './utils.js';

function encodeProjectPath(projectPath: string): string {
  // /Users/donghyun/repo/ailog → -Users-donghyun-repo-ailog
  return projectPath.replace(/\//g, '-');
}

export async function copyClaudeLogs(
  targetDir: string,
  projectPath: string
): Promise<void> {
  const homeDir = getHomeDir();
  const encodedPath = encodeProjectPath(projectPath);

  const claudeProjectDir = path.join(
    homeDir,
    '.claude',
    'projects',
    encodedPath
  );
  const destDir = path.join(targetDir, 'claude');

  if (!(await exists(claudeProjectDir))) {
    log(`⚠️  Claude Code logs not found for: ${projectPath}`);
    return;
  }

  log('📋 Copying Claude Code logs...');
  await copyDir(claudeProjectDir, destDir);
  log('   Claude Code logs copied');
}
