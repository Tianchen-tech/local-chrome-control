import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { PROJECT_ROOT, privateDirectory, writePrivateJson, extensionOrigin } from '../server/paths.mjs';
import { installPlan, launcherText } from '../server/platform.mjs';
import { privateWindowsPaths, secureWindowsDirectory, secureWindowsFile, registryEntries, updateRegistry, powershellJson } from '../server/windows-security.mjs';
import { NativeDecoder, nativeFrame } from '../server/framing.mjs';
import { buildWindowsLauncher } from '../server/windows-launcher.mjs';
const windows = { skip: process.platform !== 'win32', timeout: 25_000 };

test('Windows NTFS ownership and ACL deny a descriptor explicitly shared to another identity', windows, async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-acl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // Diagnostic stderr is limited to this disposable test directory and contains
  // no real browser/profile data. Production errors remain sanitized.
  const execute = (exe, args, options, input) => new Promise((resolve, reject) => {
    const child = execFile(exe, args, options, (error, stdout, stderr) => {
      if (error) { t.diagnostic(stderr); reject(error); } else resolve({ stdout });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  await secureWindowsDirectory(directory, execute);
  const file = path.join(directory, 'descriptor.json'); await writePrivateJson(file, { example: true });
  assert.deepEqual(await privateWindowsPaths(directory, [file]), { directory: true, files: [file] });
  await powershellJson(`$acl=Get-Acl -LiteralPath $data.file; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow')); [IO.File]::SetAccessControl($data.file,$acl); @{changed=$true} | ConvertTo-Json -Compress;`, { file });
  assert.deepEqual(await privateWindowsPaths(directory, [file]), { directory: true, files: [] });
});
test('Windows private directory and file setup can be repeated without audit privileges', windows, async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-repeat-acl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  await privateDirectory(directory);
  const file = path.join(directory, 'descriptor.json');
  await writePrivateJson(file, { example: true });
  await secureWindowsFile(file);
  assert.deepEqual(await privateWindowsPaths(directory, [file]), { directory: true, files: [file] });
});
test('Windows registry registration covers both views, refuses conflicts and removes only its own test key', windows, async t => {
  const key = 'Software\\LocalChromeControlTests\\case' + process.pid;
  const file = path.join(tmpdir(), 'lcc-registry-' + process.pid + '.json');
  assert.deepEqual((await registryEntries(key)).entries, []);
  t.after(() => updateRegistry(key, file, true));
  await updateRegistry(key, file);
  const entries = (await registryEntries(key)).entries;
  assert.deepEqual(entries.map(e => e.view), ['Registry32', 'Registry64']); assert.ok(entries.every(e => e.path === file));
  await assert.rejects(updateRegistry(key, file + '-unrelated', true));
  assert.deepEqual((await registryEntries(key)).entries, entries);
  await updateRegistry(key, file, true); assert.deepEqual((await registryEntries(key)).entries, []);
});
test('Windows batch Native Messaging launcher forwards origin and parent-window and preserves binary stdio', windows, async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-batch-'));
  await privateDirectory(directory); const origin = await extensionOrigin();
  const project = path.join(directory, 'source 中文 & 100% !');
  await fs.mkdir(project);
  await fs.cp(path.join(PROJECT_ROOT, 'server'), path.join(project, 'server'), { recursive: true });
  await fs.cp(path.join(PROJECT_ROOT, 'extension'), path.join(project, 'extension'), { recursive: true });
  const plan = { ...installPlan({ root: directory, project, node: process.execPath, host: 'com.localchrome.control', origin }), launcherPath: path.join(directory, 'legacy-native-host.cmd') };
  await fs.writeFile(plan.launcherPath, launcherText(plan, process.execPath, project));
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const host = spawn(cmd, ['/d', '/s', '/c', '""' + plan.launcherPath + '" "' + origin + '" --parent-window=0"'],
    { windowsVerbatimArguments: true, windowsHide: true, env: { ...process.env, LOCAL_CHROME_CONTROL_DIR: directory } });
  const chunks = []; host.stdout.on('data', d => chunks.push(d)); host.stderr.resume();
  t.after(async () => { host.stdin.end(); if (host.exitCode === null) await once(host, 'exit'); await fs.rm(directory, { recursive: true, force: true }); });
  const welcome = new Promise((resolve, reject) => {
    const decoder = new NativeDecoder(message => { if (message.type === 'welcome') resolve(message); });
    host.stdout.on('data', d => { try { decoder.push(d); } catch (e) { reject(e); } });
    host.once('exit', code => { if (code !== 0) reject(new Error('launcher exited ' + code)); });
  });
  const hello = { v: 1, type: 'hello', origin, version: '中文', methods: ['status'], padding: '' };
  hello.padding = 'x'.repeat((10 - Buffer.byteLength(JSON.stringify(hello)) % 256 + 256) % 256);
  const framed = nativeFrame(hello);
  assert.equal(framed[0], 10, 'a prefix byte of LF must not become Windows CRLF');
  host.stdin.write(framed);
  assert.match((await welcome).session_id, /^[a-f0-9]{12}$/);
  assert.equal(Buffer.concat(chunks).readUInt32LE(0), Buffer.concat(chunks).length - 4);
});

for (const detached of [false, true]) {
  test('Windows executable launcher preserves binary native messages ' + (detached ? 'without a console' : 'with inherited console state'), windows, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-exe-'));
    await privateDirectory(directory);
    const origin = await extensionOrigin();
    const project = path.join(directory, 'source 中文 & 100% !');
    await fs.mkdir(project);
    await fs.cp(path.join(PROJECT_ROOT, 'server'), path.join(project, 'server'), { recursive: true });
    await fs.cp(path.join(PROJECT_ROOT, 'extension'), path.join(project, 'extension'), { recursive: true });
    const executable = path.join(directory, 'native-host.exe');
    await buildWindowsLauncher(executable, process.execPath, project);
    await buildWindowsLauncher(executable, process.execPath, project);
    const host = spawn(executable, [origin, '--parent-window=0'], {
      windowsHide: true, detached, env: { ...process.env, LOCAL_CHROME_CONTROL_DIR: directory }
    });
    const exited = once(host, 'exit');
    host.stderr.resume();
    t.after(async () => {
      host.stdin.end();
      const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
      if (!stopped) { host.kill(); await exited; }
      await fs.rm(directory, { recursive: true, force: true });
    });
    const chunks = [];
    const welcome = new Promise((resolve, reject) => {
      const decoder = new NativeDecoder(message => { if (message.type === 'welcome') resolve(message); });
      host.stdout.on('data', chunk => {
        chunks.push(chunk);
        try { decoder.push(chunk); } catch (error) { reject(error); }
      });
      host.once('exit', code => reject(new Error('executable launcher exited ' + code)));
      host.once('error', reject);
    });
    const hello = { v: 1, type: 'hello', origin, version: '中文', methods: ['status'], padding: '' };
    hello.padding = 'x'.repeat((10 - Buffer.byteLength(JSON.stringify(hello)) % 256 + 256) % 256);
    const framed = nativeFrame(hello);
    assert.equal(framed[0], 10);
    host.stdin.write(framed);
    assert.match((await welcome).session_id, /^[a-f0-9]{12}$/);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
  });
}
