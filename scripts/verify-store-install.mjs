// Registration is exercised only on a disposable GitHub Actions runner.
// Chrome is simulated here: this verifies the installed launcher / IPC / MCP
// identity, not a Web Store installation or a real user's popup consent.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { PROJECT_ROOT, extensionOrigin } from '../server/paths.mjs';
import { installPlan } from '../server/platform.mjs';
import { registryEntries } from '../server/windows-security.mjs';
import { NativeDecoder, nativeFrame, LineDecoder } from '../server/framing.mjs';
import { HOST_NAME, VERSION } from '../extension/protocol.mjs';

if (!process.argv.includes('--on-disposable-ci') || process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
  throw new Error('Run only with --on-disposable-ci on a disposable GitHub Actions runner. No registration changed.');
}
const execute = promisify(execFile);
const identity = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'docs/STORE-IDENTITY.json'), 'utf8'));
const origin = await extensionOrigin();
assert.equal(origin, identity.origin);
assert.equal(origin, 'chrome-extension://' + identity.item_id + '/');
const plan = installPlan({ project: PROJECT_ROOT, node: process.execPath, host: HOST_NAME, origin });
const installer = path.join(PROJECT_ROOT, 'scripts/install.mjs');
const reportPath = path.join(PROJECT_ROOT, 'dist/store-install.json');
let installed = false, host, mcp;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin.end();
  if (!await Promise.race([exited.then(() => true), wait(5000).then(() => false)])) {
    child.kill(); await exited;
  }
}
try {
  // Never overwrite a preexisting registration, even one that looks like ours.
  assert.equal(await fs.lstat(plan.manifestPath).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  }), false, 'disposable runner must start without this native host');
  if (plan.registryKey) assert.deepEqual((await registryEntries(plan.registryKey)).entries, []);
  await execute(process.execPath, [installer, '--install'], { timeout: 60000 }); installed = true;
  await execute(process.execPath, [installer, '--install'], { timeout: 60000 });
  const actual = JSON.parse(await fs.readFile(plan.manifestPath, 'utf8'));
  assert.deepEqual(actual.allowed_origins, [origin]);
  assert.equal(actual.path, plan.launcherPath);
  if (plan.registryKey) {
    const entries = (await registryEntries(plan.registryKey)).entries;
    assert.deepEqual(entries.map(e => e.view), ['Registry32', 'Registry64']);
    assert.ok(entries.every(e => e.path === plan.manifestPath));
  }
  // Launch the actual registered executable, not node native-host.mjs directly.
  host = spawn(actual.path, [origin, '--parent-window=0'], { windowsHide: true });
  host.stderr.resume();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const decoder = new NativeDecoder(message => {
    if (message.type === 'welcome') readyResolve(message);
    if (message.type === 'ping') host.stdin.write(nativeFrame({ v: 1, type: 'pong' }));
    if (message.type === 'command') host.stdin.write(nativeFrame({ v: 1, type: 'response', id: message.id,
      result: { fixture: 'simulated Chrome', method: message.method, store_origin: origin } }));
  });
  host.stdout.on('data', chunk => { try { decoder.push(chunk); } catch (error) { readyReject(error); } });
  host.once('error', readyReject); host.once('exit', code => readyReject(new Error('launcher exited ' + code)));
  host.stdin.on('error', readyReject);
  host.stdin.write(nativeFrame({ v: 1, type: 'hello', origin, version: VERSION, methods: ['status'] }));
  const welcome = await bounded(ready, 30000, 'launcher welcome timed out');
  mcp = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server/mcp.mjs')]);
  mcp.stderr.resume();
  let id = 0; const pending = new Map();
  const lines = new LineDecoder(message => { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); entry(message); } });
  mcp.stdout.on('data', chunk => lines.push(chunk));
  const rpc = (method, params = {}) => {
    const callId = ++id;
    const result = new Promise(resolve => { pending.set(callId, resolve); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\n');
    return bounded(result, 20000, 'MCP response timed out');
  };
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'store-install-fixture', version: '1' } })).result.serverInfo.version, VERSION);
  const sessions = await rpc('tools/call', { name: 'sessions_list', arguments: {} });
  assert.ok(JSON.parse(sessions.result.content[0].text).sessions.some(session => session.session_id === welcome.session_id));
  const status = await rpc('tools/call', { name: 'status', arguments: { session_id: welcome.session_id } });
  assert.equal(status.result.isError, undefined);
  assert.equal(JSON.parse(status.result.content[0].text).store_origin, origin);
  await stop(mcp); await stop(host);
  // The installed launcher must reject the separate developer identity.
  const wrong = spawn(actual.path, ['chrome-extension://afkdbekkfjphihnmmhhiahdncbkhogpd/'], { windowsHide: true });
  wrong.stdout.resume(); wrong.stderr.resume(); wrong.stdin.end();
  let code;
  try { [code] = await bounded(once(wrong, 'exit'), 10000, 'wrong-origin rejection timed out'); }
  finally { if (wrong.exitCode === null && wrong.signalCode === null) wrong.kill(); }
  assert.equal(code, 1);
  await execute(process.execPath, [installer, '--uninstall'], { timeout: 60000 }); installed = false;
  assert.equal(await fs.access(plan.manifestPath).then(() => true, () => false), false);
  if (plan.registryKey) assert.deepEqual((await registryEntries(plan.registryKey)).entries, []);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ version: VERSION, item_id: identity.item_id, platform: process.platform,
    node: process.version, status: 'passed', registration: 'install twice / verify origin / uninstall',
    native_path: 'installed launcher -> real IPC -> real MCP; simulated Chrome endpoint',
    rejects_developer_origin: true, real_store_extension_install: false }, null, 2) + '\n');
  console.log('Store identity registration and native transport passed: ' + identity.item_id);
} finally {
  await stop(mcp); await stop(host);
  if (installed) await execute(process.execPath, [installer, '--uninstall'], { timeout: 60000 });
}
