import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../server/paths.mjs';
if (process.platform !== 'win32') throw new Error('Run this setup on Windows.');
const install = process.argv.includes('--install'), uninstall = process.argv.includes('--uninstall');
if (install && uninstall) throw new Error('Choose --install or --uninstall.');
// Preview is read-only. Only the explicit install regenerates machine paths.
const steps = [...(install ? [['prepare.mjs']] : []), ['install.mjs', ...(install ? ['--install'] : uninstall ? ['--uninstall'] : [])]];
for (const [script, ...args] of steps) {
  const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', script), ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
