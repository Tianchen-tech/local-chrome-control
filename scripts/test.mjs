import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../server/paths.mjs';
const directory = path.join(PROJECT_ROOT, 'tests');
const files = (await fs.readdir(directory)).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(directory, f));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
