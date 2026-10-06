import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { NativeDecoder, LineDecoder, nativeFrame } from './framing.mjs';
import { PROJECT_ROOT, privateDirectory, extensionOrigin, writePrivateJson } from './paths.mjs';
import { METHODS, MUTATIONS, WIRE_VERSION, validate, errorObject } from '../extension/protocol.mjs';

// stdout is exclusively Chrome's binary native-messaging stream.
const allowed = await extensionOrigin();
if (process.argv[2] !== allowed) {
  process.stderr.write('Local Chrome Control: invalid extension origin\n');
  process.exit(1);
}
const root = await privateDirectory();
const sessionId = randomBytes(6).toString('hex');
const socketPath = path.join(root, sessionId + '.sock');
if (Buffer.byteLength(socketPath) > 100) {
  process.stderr.write('Local Chrome Control: runtime path too long for a Unix socket\n');
  process.exit(1);
}
const descriptorPath = path.join(root, sessionId + '.json');
const token = randomBytes(32).toString('hex');
const pending = new Map();
const clients = new Set();
let ready = false;
let shuttingDown = false;
let lastPong = Date.now();
let helloTimer;
let heartbeatTimer;
const descriptor = { protocol: WIRE_VERSION, session_id: sessionId, socket_path: socketPath, token,
  pid: process.pid, started_at: new Date().toISOString(), extension_version: null, extension_methods: null };

function send(message) { if (!shuttingDown) process.stdout.write(nativeFrame(message)); }
function respond(socket, message) {
  if (!socket.destroyed) socket.end(JSON.stringify(message) + '\n');
}
function diagnostic(event, fields = {}) {
  // Metadata only: never write URLs, snapshots, screenshots, lease tokens or input values.
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}
// Chrome may run an older copy of the extension than this host, e.g. one loaded from another folder.
function outdated(method) {
  return { error: { code: 'EXTENSION_OUTDATED', message: 'Chrome 中运行的扩展版本较旧，不支持 ' + method +
    '。请打开 chrome://extensions，确认扩展加载目录是 ' + path.join(PROJECT_ROOT, 'extension') +
    '，点击重新加载，然后在扩展弹窗中重新授权标签页。' } };
}
function authenticate(supplied) {
  if (typeof supplied !== 'string' || supplied.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}
const server = net.createServer(socket => {
  clients.add(socket);
  socket.setTimeout(20_000, () => socket.destroy());
  let seen = false;
  const decoder = new LineDecoder(message => {
    if (seen) { socket.destroy(); return; }
    seen = true;
    if (!authenticate(message.token)) { respond(socket, { error: { code: 'UNAUTHORIZED', message: '本地连接身份验证失败。' } }); return; }
    if (!ready) { respond(socket, { error: { code: 'EXTENSION_NOT_READY', message: 'Chrome 扩展尚未准备好。' } }); return; }
    const id = randomUUID();
    try { validate(message.method, message.args); }
    catch (error) { respond(socket, { error: errorObject(error) }); return; }
    if (descriptor.extension_methods && !descriptor.extension_methods.includes(message.method)) {
      respond(socket, outdated(message.method)); return;
    }
    const budget = message.method === 'page_screenshot' ? 12_000 : 8_000;
    const deadline = Date.now() + budget;
    const started = Date.now();
    const timer = setTimeout(() => {
      pending.delete(id);
      const code = MUTATIONS.has(message.method) ? 'ACTION_STATUS_UNKNOWN' : 'TIMEOUT';
      diagnostic('timeout', { method: message.method, elapsed_ms: Date.now() - started, code });
      respond(socket, { error: { code, message: MUTATIONS.has(message.method) ?
        '未收到操作结果。可能已执行；先核对页面，禁止自动重试。' : 'Chrome 扩展没有在时限内返回。' } });
    }, budget + 500);
    pending.set(id, { socket, timer, method: message.method, started });
    send({ v: WIRE_VERSION, type: 'command', id, method: message.method, args: message.args || {}, deadline });
  });
  socket.on('data', chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } });
  socket.on('error', () => {});
  socket.on('close', () => { clients.delete(socket); });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
await fs.chmod(socketPath, 0o600);

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(helloTimer);
  clearInterval(heartbeatTimer);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.socket.destroy(); }
  for (const socket of clients) socket.destroy();
  server.close();
  await Promise.all([fs.unlink(socketPath).catch(() => {}), fs.unlink(descriptorPath).catch(() => {})]);
  process.exit(code);
}
const decoder = new NativeDecoder(message => {
  if (message?.v !== WIRE_VERSION) { void shutdown(1); return; }
  lastPong = Date.now();
  if (message.type === 'hello') {
    if (ready || message.origin !== allowed) { void shutdown(1); return; }
    descriptor.extension_version = String(message.version || '').slice(0, 30);
    // Extensions from before the method report leave this null; their UNKNOWN_METHOD replies are mapped below.
    descriptor.extension_methods = Array.isArray(message.methods) ?
      message.methods.filter(m => typeof m === 'string' && m.length <= 40).slice(0, 64) : null;
    void writePrivateJson(descriptorPath, descriptor).then(() => {
      ready = true;
      clearTimeout(helloTimer);
      send({ v: WIRE_VERSION, type: 'welcome', session_id: sessionId });
      diagnostic('ready', { session_id: sessionId });
    }).catch(() => shutdown(1));
  } else if (message.type === 'response') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const reply = message.error?.code === 'UNKNOWN_METHOD' && METHODS.has(entry.method) ? outdated(entry.method) :
      message.error ? { error: message.error } : { result: message.result };
    diagnostic('command', { method: entry.method, elapsed_ms: Date.now() - entry.started, code: reply.error?.code || 'OK' });
    respond(entry.socket, reply);
  }
});
process.stdin.on('data', chunk => { try { decoder.push(chunk); } catch { void shutdown(1); } });
process.stdin.on('end', () => void shutdown());
process.stdin.on('error', () => void shutdown(1));
process.stdout.on('error', () => void shutdown(1));
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
helloTimer = setTimeout(() => void shutdown(1), 10_000);
heartbeatTimer = setInterval(() => {
  if (Date.now() - lastPong > 35_000) { void shutdown(1); return; }
  if (ready) send({ v: WIRE_VERSION, type: 'ping' });
}, 10_000);
