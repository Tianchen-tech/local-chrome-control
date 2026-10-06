import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { runtimeRoot } from './paths.mjs';
import { LineDecoder } from './framing.mjs';
import { ControlError, METHODS, MUTATIONS } from '../extension/protocol.mjs';

export async function discover() {
  const root = runtimeRoot();
  let files;
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return [];
    files = await fs.readdir(root);
  } catch { return []; }
  const found = [];
  for (const file of files.filter(f => /^[a-f0-9]{12}\.json$/.test(f))) {
    try {
      const filename = path.join(root, file);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) continue;
      const entry = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (entry.session_id !== file.slice(0, -5) || entry.socket_path !== path.join(root, entry.session_id + '.sock') || !/^[a-f0-9]{64}$/.test(entry.token)) continue;
      const socketStat = await fs.lstat(entry.socket_path);
      if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o077)) continue;
      process.kill(entry.pid, 0);
      found.push(entry);
    } catch { /* A stale endpoint is ignored, never deleted or followed elsewhere. */ }
  }
  return found;
}
export function publicSession(entry) {
  // null means the extension predates the method report, so it is older than this project.
  const missing = Array.isArray(entry.extension_methods) ? [...METHODS].filter(m => !entry.extension_methods.includes(m)) : null;
  return { session_id: entry.session_id, started_at: entry.started_at, extension_version: entry.extension_version,
    extension_missing_methods: missing };
}
export async function bridgeCall(method, args = {}) {
  const sessions = await discover();
  const matches = args.session_id ? sessions.filter(s => s.session_id === args.session_id) : sessions;
  if (!matches.length) throw new ControlError('NO_CHROME_CONNECTION', '未发现本地 Chrome 连接。请打开扩展并检查本地连接程序是否已安装。');
  if (matches.length > 1) throw new ControlError('MULTIPLE_CHROME_SESSIONS', '有多个 Chrome 配置连接，请从 sessions_list 选择 session_id。');
  return request(matches[0], method, args);
}
export function request(session, method, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socket_path);
    let finished = false;
    let sent = false;
    const stop = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const ambiguous = () => new ControlError(sent && MUTATIONS.has(method) ? 'ACTION_STATUS_UNKNOWN' : 'BRIDGE_DISCONNECTED',
      sent && MUTATIONS.has(method) ? '本地连接在操作后断开。先核对页面，禁止自动重试。' : '本地连接已断开，请点击扩展中的重新连接。');
    const timer = setTimeout(() => stop(ambiguous()), method === 'page_screenshot' ? 14_000 : 10_000);
    const decoder = new LineDecoder(message => {
      if (message.error) stop(new ControlError(message.error.code, message.error.message, message.error.details));
      else stop(null, message.result);
    }, 12 * 1024 * 1024);
    socket.on('connect', () => {
      sent = true;
      socket.write(JSON.stringify({ token: session.token, method, args }) + '\n');
    });
    socket.on('data', chunk => { try { decoder.push(chunk); } catch { stop(new ControlError('INVALID_BRIDGE_RESPONSE', '连接程序返回了无效数据。')); } });
    socket.on('error', () => stop(ambiguous()));
    socket.on('end', () => { if (!finished) stop(ambiguous()); });
  });
}
