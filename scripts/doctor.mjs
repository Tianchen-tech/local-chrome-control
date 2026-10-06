import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_ROOT, extensionOrigin } from '../server/paths.mjs';
import { HOST_NAME } from '../extension/protocol.mjs';
import { discover, request, publicSession } from '../server/bridge-client.mjs';
const filename = path.join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', HOST_NAME + '.json');
let installed = false;
try {
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
  installed = manifest.allowed_origins?.includes(await extensionOrigin()) && Boolean(await fs.stat(manifest.path));
} catch {}
const results = [];
for (const s of await discover()) {
  try { results.push({ ...publicSession(s), status: await request(s, 'status', {}) }); }
  catch (e) { results.push({ ...publicSession(s), error: e.code }); }
}
const stale = results.some(r => r.extension_missing_methods === null || r.extension_missing_methods?.length);
console.log(JSON.stringify({ native_host_installed: installed, connections: results,
  ...(stale ? { extension_outdated: 'Chrome 中运行的扩展比本项目旧。请在 chrome://extensions 确认扩展加载目录是 ' +
    path.join(PROJECT_ROOT, 'extension') + '，然后点击重新加载。' } : {}),
  note: '连接成功不等于页面可控。首次验收还需授权测试页并完成读取、点击、填表和截图。' }, null, 2));
