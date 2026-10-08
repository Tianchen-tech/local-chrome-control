import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, extensionOrigin, privateDirectory, writePrivateJson } from '../server/paths.mjs';
import { installPlan, launcherText, ownsManifest, sameInstallationPath } from '../server/platform.mjs';
import { registryEntries, updateRegistry } from '../server/windows-security.mjs';
import { buildWindowsLauncher, windowsLauncherSource } from '../server/windows-launcher.mjs';
import { HOST_NAME } from '../extension/protocol.mjs';
const apply = process.argv.includes('--install'), remove = process.argv.includes('--uninstall');
if (apply && remove) throw new Error('Choose --install or --uninstall.');
const plan = installPlan({ project: PROJECT_ROOT, node: process.execPath, host: HOST_NAME, origin: await extensionOrigin() });
const launcher = plan.platform === 'win32' ? await windowsLauncherSource(process.execPath, PROJECT_ROOT) : launcherText(plan, process.execPath, PROJECT_ROOT);
console.log(JSON.stringify({ mode: remove ? 'uninstall' : apply ? 'install' : 'preview-only', platform: plan.platform,
  native_manifest: plan.manifestPath, launcher: plan.launcherPath,
  ...(plan.registryKey ? { registry: 'HKCU\\' + plan.registryKey, registry_views: ['32', '64'] } : {}),
  allowed_extension: plan.manifest.allowed_origins[0], extension_folder: path.join(PROJECT_ROOT, 'extension'),
  mcp_command: plan.mcp.command, mcp_args: plan.mcp.args,
  permissions: ['activeTab', 'debugger', 'nativeMessaging', 'storage', 'alarms'] }, null, 2));
async function readFile(filename, encoding = 'utf8') {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing a linked or non-file installation target.');
    return await fs.readFile(filename, encoding);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
if (!apply && !remove) console.log('\nPreview only. Run node scripts/install.mjs --install to register this user\'s native host.');
else {
  // Inspect every registration and file before any install/uninstall mutation.
  if (plan.registryKey) {
    const { entries } = await registryEntries(plan.registryKey);
    if (entries.some(e => !sameInstallationPath(e.path, plan.manifestPath))) throw new Error('An unrelated registry host uses this name. Nothing changed.');
  }
  const raw = await readFile(plan.manifestPath);
  const existing = raw === null ? null : JSON.parse(raw);
  const ownsCurrentLauncher = existing && ownsManifest(existing, plan.manifest);
  let ownsExisting = ownsCurrentLauncher;
  if (existing && !ownsExisting && plan.platform === 'win32') {
    const legacyPath = path.join(path.dirname(plan.launcherPath), 'native-host.cmd');
    const legacyManifest = { ...plan.manifest, path: legacyPath };
    // Migrate only the exact batch launcher generated for this project and Node.
    ownsExisting = ownsManifest(existing, legacyManifest) &&
      await readFile(legacyPath) === launcherText(plan, process.execPath, PROJECT_ROOT);
  }
  if (existing && !ownsExisting) throw new Error('An unrelated native host uses this name. Nothing changed.');
  const existingLauncher = await readFile(plan.launcherPath, plan.platform === 'win32' ? null : 'utf8');
  const existingSource = plan.platform === 'win32' ? await readFile(plan.launcherPath + '.cs') : null;
  // A matching current manifest owns its launcher, including an older template
  // from this installation. Without that manifest, require the exact source;
  // legacy batch migration must not overwrite an unrelated executable.
  if (plan.platform === 'win32' && !ownsCurrentLauncher && (existingLauncher !== null || existingSource !== null) && existingSource !== launcher ||
    plan.platform !== 'win32' && !existing && existingLauncher !== null && existingLauncher !== launcher) {
    throw new Error('An unrelated launcher uses this path. Nothing changed.');
  }
  if (apply) {
    await privateDirectory(); await fs.mkdir(plan.directory, { recursive: true });
    const directoryStat = await fs.lstat(plan.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Refusing a linked native manifest directory.');
    if (plan.platform === 'win32') await buildWindowsLauncher(plan.launcherPath, process.execPath, PROJECT_ROOT);
    else { await fs.writeFile(plan.launcherPath, launcher, { mode: 0o700 }); await fs.chmod(plan.launcherPath, 0o700); }
    await writePrivateJson(plan.manifestPath, plan.manifest);
    if (plan.registryKey) await updateRegistry(plan.registryKey, plan.manifestPath);
    console.log('\nNative host installed for this user. Load the extension folder in Chrome and authorize a tab yourself.');
  } else {
    if (plan.registryKey) await updateRegistry(plan.registryKey, plan.manifestPath, true);
    if (existing) await fs.unlink(plan.manifestPath);
    if (existingLauncher !== null) await fs.unlink(plan.launcherPath);
    if (existingSource !== null) await fs.unlink(plan.launcherPath + '.cs');
    console.log('\nNative host registration and launcher removed. Remove the Chrome extension and MCP entry in their own settings.');
  }
}
