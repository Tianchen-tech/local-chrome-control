// Starts only owned loopback fixtures and a fresh isolated Chrome profile.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { PROJECT_ROOT } from '../server/paths.mjs';
const server = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'fixture-modes.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
let probe;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 5000);
    let output = '';
    server.stdout.on('data', data => { output += data; if (output.includes('19321')) { clearTimeout(timer); resolve(); } });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited ' + code)); });
  });
  probe = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'probe-browser.mjs'), process.argv[2] || path.join(PROJECT_ROOT, 'dist', 'browser-probe')], { stdio: 'inherit' });
  const [code] = await once(probe, 'exit'); process.exitCode = code ?? 1;
} finally {
  if (probe && probe.exitCode === null) probe.kill('SIGTERM');
  if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
}
