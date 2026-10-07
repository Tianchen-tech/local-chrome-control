// Starts only owned loopback fixtures and a fresh isolated Chrome profile.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { PROJECT_ROOT } from '../server/paths.mjs';
const server = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'fixture-modes.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const serverExited = new Promise(resolve => { server.once('exit', resolve); server.once('error', resolve); });
const alive = child => child.exitCode === null && child.signalCode === null;
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
  if (probe && alive(probe)) probe.kill('SIGTERM');
  if (alive(server)) { server.kill('SIGTERM'); await serverExited; }
}
