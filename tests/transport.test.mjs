import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { NativeDecoder, nativeFrame, LineDecoder } from '../server/framing.mjs';
import { PROJECT_ROOT, extensionOrigin, privateDirectory, privatePaths } from '../server/paths.mjs';
import { Controller } from '../extension/controller.mjs';
import { publicSession } from '../server/bridge-client.mjs';

test('real MCP process -> local IPC -> native host -> simulated Chrome controller', { timeout: process.platform === 'win32' ? 60_000 : 15_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-test-'));
  await privateDirectory(directory);
  const env = { ...process.env, LOCAL_CHROME_CONTROL_DIR: directory };
  let clicks = 0, persisted = {};
  const fakeAdapter = { async attach() {}, async detach() {}, forget() {},
    async tab() { return { id: 7, title: 'Fixture', url: 'https://example.test/' }; },
    async run(method) { if (method === 'page_click') clicks++; return method === 'page_snapshot' ? { snapshot_id: 's1', elements: [{ ref: 'e1', label: 'Submit' }] } : {}; } };
  const controller = new Controller(fakeAdapter, { async loadLedger() { return persisted; }, async saveLedger(value) { persisted = structuredClone(value); } });
  await controller.grant({ id: 7, title: 'Fixture', url: 'https://example.test/' });
  const origin = await extensionOrigin();
  const host = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server/native-host.mjs'), origin], { env });
  let diagnostics = '';
  host.stderr.on('data', d => { diagnostics += d; });
  let welcome, failWelcome;
  const welcomed = new Promise((resolve, reject) => { welcome = resolve; failWelcome = reject; });
  host.once('exit', code => { if (code) failWelcome(new Error('host exited: ' + code + ' ' + diagnostics)); });
  let dropNextWrite = false;
  const decoder = new NativeDecoder(message => {
    if (message.type === 'welcome') welcome(message);
    if (message.type === 'ping') host.stdin.write(nativeFrame({ v: 1, type: 'pong' }));
    if (message.type === 'command') {
      void (async () => {
        let reply;
        try { reply = { result: await controller.execute(message.method, message.args, message.deadline) }; }
        catch (e) { reply = { error: { code: e.code, message: e.message } }; }
        if (dropNextWrite && message.method === 'page_click') { host.kill('SIGTERM'); return; }
        host.stdin.write(nativeFrame({ v: 1, type: 'response', id: message.id, ...reply }));
      })();
    }
  });
  host.stdout.on('data', d => decoder.push(d));
  host.stdin.write(nativeFrame({ v: 1, type: 'hello', origin, version: '0.1.0' }));
  const ready = await welcomed;
  const mcp = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server/mcp.mjs')], { env });
  mcp.stderr.resume();
  t.after(async () => {
    if (mcp.exitCode === null) mcp.kill('SIGTERM');
    if (host.exitCode === null) host.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 80));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let id = 0; const pending = new Map();
  mcp.stdout.on('data', d => mcpDecoder.push(d));
  const mcpDecoder = new LineDecoder(message => { const entry = pending.get(message.id); if (entry) { pending.delete(message.id); entry(message); } });
  const rpc = (method, params) => new Promise(resolve => {
    const callId = ++id; pending.set(callId, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    return { ...response, data: response.result?.content?.[0]?.text ? JSON.parse(response.result.content[0].text) : null };
  };
  assert.equal((await rpc('tools/list', {})).error.code, -32002);
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.protocolVersion, '2025-06-18');
  const listed = (await rpc('tools/list', {})).result.tools;
  assert.equal(listed.length, 15);
  assert.equal(listed.find(t => t.name === 'page_click').annotations.readOnlyHint, false);
  const sessions = (await call('sessions_list')).data.sessions;
  assert.equal(sessions[0].session_id, ready.session_id); assert.equal(sessions[0].token, undefined);
  const tabs = (await call('tabs_list')).data.tabs; assert.equal(tabs[0].tab_id, 7);
  const lease = (await call('tab_claim', { tab_id: 7, task_name: 'Transport fixture' })).data;
  const snapshot = (await call('page_snapshot', { tab_id: 7, lease_id: lease.lease_id })).data;
  assert.equal(snapshot.snapshot_id, 's1');
  const args = { tab_id: 7, lease_id: lease.lease_id, snapshot_id: 's1', ref: 'e1', request_id: 'submit-once-001' };
  assert.equal((await call('page_click', args)).data.status, 'done');
  assert.equal((await call('page_click', args)).data.replayed, true); assert.equal(clicks, 1);
  const record = (await call('request_status', { request_id: args.request_id })).data;
  assert.equal(record.status, 'done');
  assert.equal((await rpc('tools/call', { name: 'raw_cdp', arguments: {} })).error.code, -32602);
  assert.equal((await call('page_snapshot', { tab_id: 7, lease_id: lease.lease_id, raw_js: 'bad' })).result.isError, true);
  assert.equal((await call('page_snapshot', { tab_id: 7, lease_id: lease.lease_id, constructor: 'bad' })).result.isError, true);
  const descriptor = JSON.parse(await fs.readFile(path.join(directory, ready.session_id + '.json'), 'utf8'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(descriptor.socket_path)).mode & 0o777, 0o600);
  else assert.equal((await privatePaths(directory, [path.join(directory, ready.session_id + '.json')])).files.length, 1);
  const authResult = await new Promise(resolve => {
    const socket = net.createConnection(descriptor.socket_path);
    let text = '';
    socket.on('connect', () => socket.write(JSON.stringify({ token: 'invalid', method: 'tabs_list', args: {} }) + '\n'));
    socket.on('data', d => { text += d; }); socket.on('end', () => resolve(JSON.parse(text)));
  });
  assert.equal(authResult.error.code, 'UNAUTHORIZED');
  dropNextWrite = true;
  const unknown = await call('page_click', { ...args, request_id: 'submit-lost-002' });
  assert.equal(unknown.data.code, 'ACTION_STATUS_UNKNOWN'); assert.equal(clicks, 2);
  assert.ok(!diagnostics.includes(lease.lease_id)); assert.ok(!diagnostics.includes('example.test'));
});

test('native host refuses an unexpected extension before creating a socket', { timeout: process.platform === 'win32' ? 25_000 : 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-origin-'));
  const host = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server/native-host.mjs'), 'chrome-extension://wrong/'], { env: { ...process.env, LOCAL_CHROME_CONTROL_DIR: directory } });
  host.stderr.resume(); host.stdout.resume();
  const [code] = await once(host, 'exit');
  assert.equal(code, 1); assert.deepEqual(await fs.readdir(directory), []);
  await fs.rm(directory, { recursive: true });
});

// Starts a native host with a simulated Chrome that answers every command with `reply`.
async function hostWith(t, hello, reply) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-stale-'));
  await privateDirectory(directory);
  const origin = await extensionOrigin();
  const host = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server/native-host.mjs'), origin], { env: { ...process.env, LOCAL_CHROME_CONTROL_DIR: directory } });
  host.stderr.resume();
  let sent = 0, welcome;
  const welcomed = new Promise(resolve => { welcome = resolve; });
  const decoder = new NativeDecoder(message => {
    if (message.type === 'welcome') welcome(message);
    if (message.type === 'command') { sent++; host.stdin.write(nativeFrame({ v: 1, type: 'response', id: message.id, ...reply })); }
  });
  host.stdout.on('data', d => decoder.push(d));
  host.stdin.write(nativeFrame({ v: 1, type: 'hello', origin, ...hello }));
  const { session_id } = await welcomed;
  t.after(async () => {
    if (host.exitCode === null) host.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 80));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const descriptor = JSON.parse(await fs.readFile(path.join(directory, session_id + '.json'), 'utf8'));
  const call = (method, args) => new Promise(resolve => {
    const socket = net.createConnection(descriptor.socket_path);
    let text = '';
    socket.on('connect', () => socket.write(JSON.stringify({ token: descriptor.token, method, args }) + '\n'));
    socket.on('data', d => { text += d; }); socket.on('end', () => resolve(JSON.parse(text)));
  });
  return { descriptor, call, sent: () => sent };
}
const scrollArgs = { tab_id: 7, lease_id: 'lease', direction: 'down' };

test('an extension that reports fewer methods gets EXTENSION_OUTDATED without a round trip', { timeout: process.platform === 'win32' ? 25_000 : 5000 }, async t => {
  const h = await hostWith(t, { version: '0.1.0', methods: ['status', 'tabs_list'] }, { result: {} });
  assert.ok(publicSession(h.descriptor).extension_missing_methods.includes('page_scroll'));
  const response = await h.call('page_scroll', scrollArgs);
  assert.equal(response.error.code, 'EXTENSION_OUTDATED');
  assert.ok(response.error.message.includes(path.join(PROJECT_ROOT, 'extension')));
  assert.equal(h.sent(), 0);
  assert.ok((await h.call('status', {})).result);
});

test('an extension without a method report maps UNKNOWN_METHOD to EXTENSION_OUTDATED', { timeout: process.platform === 'win32' ? 25_000 : 5000 }, async t => {
  const h = await hostWith(t, { version: '0.1.0' }, { error: { code: 'UNKNOWN_METHOD', message: '不支持的控制操作。' } });
  assert.equal(publicSession(h.descriptor).extension_missing_methods, null);
  const response = await h.call('page_scroll', scrollArgs);
  assert.equal(response.error.code, 'EXTENSION_OUTDATED'); assert.equal(h.sent(), 1);
});
