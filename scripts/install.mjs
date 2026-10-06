import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_ROOT, extensionOrigin, runtimeRoot, privateDirectory } from '../server/paths.mjs';
import { HOST_NAME } from '../extension/protocol.mjs';
if (process.platform !== 'darwin') throw new Error('This installer supports macOS only.');
const apply = process.argv.includes('--install'), remove = process.argv.includes('--uninstall');
if (apply && remove) throw new Error('Choose --install or --uninstall.');
const directory = path.join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
const manifestPath = path.join(directory, HOST_NAME + '.json');
const launcherPath = path.join(runtimeRoot(), 'native-host.sh');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(path.join(PROJECT_ROOT, 'server', 'native-host.mjs')) + ' "$@"\n';
const manifest = { name: HOST_NAME, description: 'Local Chrome Control local-only bridge', path: launcherPath, type: 'stdio', allowed_origins: [await extensionOrigin()] };
console.log(JSON.stringify({ mode: remove ? 'uninstall' : apply ? 'install' : 'preview-only', native_manifest: manifestPath, launcher: launcherPath,
  allowed_extension: manifest.allowed_origins[0], extension_folder: path.join(PROJECT_ROOT, 'extension'),
  mcp_command: process.execPath, mcp_args: [path.join(PROJECT_ROOT, 'server', 'mcp.mjs')],
  permissions: ['activeTab', 'debugger', 'nativeMessaging', 'storage', 'alarms'] }, null, 2));
if (!apply && !remove) console.log('\n尚未修改 Chrome 或 Codex 配置。审核后运行 node scripts/install.mjs --install，仅安装本地连接程序。');
else if (apply) {
  await privateDirectory(); await fs.mkdir(directory, { recursive: true });
  let existing;
  try { existing = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (existing.path !== launcherPath || JSON.stringify(existing.allowed_origins) !== JSON.stringify(manifest.allowed_origins))) throw new Error('An unrelated native host already uses this name. No files were overwritten.');
  await fs.writeFile(launcherPath, launcher, { mode: 0o700 }); await fs.chmod(launcherPath, 0o700);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log('\n本地连接程序已安装。下一步由用户在 Chrome 加载 extension 文件夹并授予权限。');
} else {
  let existing;
  try { existing = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (existing.path !== launcherPath || JSON.stringify(existing.allowed_origins) !== JSON.stringify(manifest.allowed_origins))) throw new Error('Refusing to remove an unrelated native host.');
  if (existing) await fs.unlink(manifestPath);
  await fs.unlink(launcherPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log('\n本地连接程序已移除。Chrome 扩展和 Codex MCP 项请在各自设置里移除。');
}
