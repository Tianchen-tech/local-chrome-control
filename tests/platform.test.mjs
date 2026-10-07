import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDirectory, ipcEndpoint, installPlan, launcherText, ownsManifest } from '../server/platform.mjs';
import { powershellJson } from '../server/windows-security.mjs';
import { crc32 } from '../server/zip.mjs';

const settings = { platform: 'win32', home: 'C:\\Users\\测试', env: { LOCALAPPDATA: 'C:\\Users\\测试\\AppData\\Local' }, project: 'C:\\Users\\测试 & 100% !\\plugin', node: 'C:\\Program Files\\nodejs\\node.exe', host: 'com.localchrome.control', origin: 'chrome-extension://afkdbekkfjphihnmmhhiahdncbkhogpd/' };
test('Windows defaults use local user data, never macOS folders or a network share', () => {
  const root = runtimeDirectory(settings.platform, settings.env, settings.home);
  assert.equal(root, 'C:\\Users\\测试\\AppData\\Local\\LocalChromeControl');
  assert.equal(runtimeDirectory('win32', {}, settings.home), root);
  assert.throws(() => runtimeDirectory('win32', { LOCAL_CHROME_CONTROL_DIR: '\\\\server\\share\\keys' }, settings.home));
  assert.throws(() => runtimeDirectory('win32', { LOCAL_CHROME_CONTROL_DIR: 'relative' }, settings.home));
  for (const value of ['C:\\Users\\%PATH%\\bridge', 'C:\\Users\\a&b\\bridge', 'C:\\Users\\a!b\\bridge']) {
    assert.throws(() => runtimeDirectory('win32', { LOCAL_CHROME_CONTROL_DIR: value }, settings.home), /WINDOWS_RUNTIME_PATH_CONTAINS_CMD_METACHARACTERS/);
  }
  assert.equal(runtimeDirectory('darwin', {}, '/Users/test'), '/Users/test/Library/Application Support/LocalChromeControl');
});
test('IPC endpoints separate users and sessions and cannot redirect discovery to a remote pipe', () => {
  const root = runtimeDirectory(settings.platform, settings.env, settings.home), id = '123456abcdef';
  const pipe = ipcEndpoint(root, id, 'win32');
  assert.match(pipe, /^\\\\\.\\pipe\\LocalChromeControl-[a-f0-9]{24}-123456abcdef$/);
  assert.equal(pipe, ipcEndpoint(root.toUpperCase(), id, 'win32'));
  assert.notEqual(pipe, ipcEndpoint('C:\\Users\\other\\AppData\\Local\\LocalChromeControl', id, 'win32'));
  assert.notEqual(pipe, ipcEndpoint(root, 'abcdef123456', 'win32'));
  assert.throws(() => ipcEndpoint(root, '../remote', 'win32'));
  assert.throws(() => ipcEndpoint('/' + 'x'.repeat(100), id, 'darwin'));
});
test('Windows install plan keeps the extension identity and uses a user registry host', () => {
  const plan = installPlan(settings);
  assert.equal(plan.registryKey, 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.localchrome.control');
  assert.equal(plan.manifest.type, 'stdio'); assert.deepEqual(plan.manifest.allowed_origins, [settings.origin]);
  assert.ok(plan.launcherPath.endsWith('native-host.cmd'));
  assert.equal(plan.mcp.args[0], settings.project + '\\server\\mcp.mjs');
  assert.equal(ownsManifest(plan.manifest, plan.manifest), true);
  assert.equal(ownsManifest({ ...plan.manifest, path: plan.manifest.path.toUpperCase() }, plan.manifest), true);
  assert.equal(ownsManifest({ ...plan.manifest, allowed_origins: ['chrome-extension://other/'] }, plan.manifest), false);
  assert.equal(ownsManifest({ ...plan.manifest, name: 'different.host' }, plan.manifest), false);
});
test('batch launcher quotes spaces and metacharacters, disables delayed expansion and keeps stdout binary', () => {
  const plan = installPlan(settings), text = launcherText(plan, settings.node, settings.project);
  assert.ok(text.startsWith('@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nif errorlevel 1 exit /b 1\r\n'));
  assert.ok(text.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\测试 & 100%% !\\plugin\\server\\native-host.mjs" %*'));
  assert.ok(!text.includes('powershell')); assert.throws(() => launcherText(plan, 'C:\\bad"path', settings.project));
  const mac = installPlan({ ...settings, platform: 'darwin', home: '/Users/test', env: {}, project: "/Users/test/a'b", node: '/usr/local/bin/node' });
  assert.equal(mac.registryKey, null); assert.match(launcherText(mac, '/usr/local/bin/node', "/Users/test/a'b"), /exec.*"\$@"/);
});
test('PowerShell receives Unicode paths as data and no argument is interpolated as code', async () => {
  const value = { filename: "C:\\测试\\x'; Remove-Item evil; '" };
  await powershellJson('@{checked=$true} | ConvertTo-Json -Compress;', value, async (exe, args, options, input) => {
    assert.ok(exe.endsWith('powershell.exe')); assert.equal(options.windowsHide, true);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(!script.includes('Remove-Item evil'));
    assert.ok(script.includes('[Console]::In.ReadToEnd()'));
    assert.deepEqual(JSON.parse(Buffer.from(input, 'base64').toString('utf8')), value);
    return { stdout: '\uFEFF{"checked":true}\r\n' };
  });
});
test('PowerShell failures do not expose a raw security command or private path', async () => {
  await assert.rejects(powershellJson('throw', {}, async () => { throw new Error('secret token and private path'); }), { message: 'WINDOWS_SECURITY_CHECK_FAILED' });
});
test('archive CRC agrees with the standard known vector', () => assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926));
