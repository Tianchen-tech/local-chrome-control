import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, extensionOrigin, runtimeRoot, privatePaths } from '../server/paths.mjs';
import { installPlan, ownsManifest, sameInstallationPath } from '../server/platform.mjs';
import { registryEntries } from '../server/windows-security.mjs';
import { HOST_NAME } from '../extension/protocol.mjs';
import { discover, request, publicSession } from '../server/bridge-client.mjs';
const plan = installPlan({ project: PROJECT_ROOT, node: process.execPath, host: HOST_NAME, origin: await extensionOrigin() });
let installed = false, registry = null, privateRuntime = null, installation_error = null;
try {
  if (plan.registryKey) {
    registry = await registryEntries(plan.registryKey);
    privateRuntime = await privatePaths(runtimeRoot());
  }
  const manifest = JSON.parse(await fs.readFile(plan.manifestPath, 'utf8'));
  const stat = await fs.lstat(plan.launcherPath);
  installed = ownsManifest(manifest, plan.manifest) && stat.isFile() && !stat.isSymbolicLink() &&
    (!registry || registry.entries.length > 0 && registry.entries.every(e => sameInstallationPath(e.path, plan.manifestPath))) &&
    (!privateRuntime || privateRuntime.directory);
} catch (error) { installation_error = error.code || error.message; }
const results = [];
for (const s of await discover()) {
  try { results.push({ ...publicSession(s), status: await request(s, 'status', {}) }); }
  catch (e) { results.push({ ...publicSession(s), error: e.code }); }
}
const stale = results.some(r => r.extension_missing_methods === null || r.extension_missing_methods?.length);
console.log(JSON.stringify({ platform: process.platform, transport: process.platform === 'win32' ? 'named-pipe' : 'unix-socket',
  native_host_installed: installed, ...(installation_error ? { installation_error } : {}),
  ...(registry ? { registry_views: registry.entries.map(e => e.view), private_runtime: privateRuntime?.directory ?? false } : {}), connections: results,
  ...(stale ? { extension_outdated: 'Chrome 中运行的扩展比本项目旧。请在 chrome://extensions 确认扩展加载目录是 ' +
    path.join(PROJECT_ROOT, 'extension') + '，然后点击重新加载。' } : {}),
  note: '连接成功不等于页面可控。首次验收还需授权测试页并完成读取、点击、填表和截图。' }, null, 2));
