import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { PROJECT_ROOT, extensionId } from '../server/paths.mjs';
import { VERSION } from '../extension/protocol.mjs';
const manifestPath = path.join(PROJECT_ROOT, 'extension', 'manifest.json');
let key;
try { key = JSON.parse(await fs.readFile(manifestPath, 'utf8')).key; } catch {}
if (!key) key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const manifest = { manifest_version: 3, name: '本地 Chrome 控制 · Local Chrome Control', short_name: 'Local Chrome',
  version: VERSION, minimum_chrome_version: '125', description: '只控制你手动授权的标签页。支持本地连接、页面读取、填表、点击及截图。',
  key, permissions: ['activeTab', 'debugger', 'nativeMessaging', 'storage', 'alarms'],
  background: { service_worker: 'service-worker.mjs', type: 'module' },
  action: { default_title: '本地 Chrome 控制', default_popup: 'popup.html', default_icon: { '16': 'icons/icon16.png', '32': 'icons/icon32.png' } },
  icons: { '16': 'icons/icon16.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none';" }
};
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(PROJECT_ROOT, '.mcp.json'), JSON.stringify({
  mcpServers: { local_chrome: { command: process.execPath, args: [path.join(PROJECT_ROOT, 'server', 'mcp.mjs')] } }
}, null, 2) + '\n');
console.log(JSON.stringify({ extension_id: extensionId(key), extension_path: path.join(PROJECT_ROOT, 'extension'), node: process.execPath }, null, 2));
