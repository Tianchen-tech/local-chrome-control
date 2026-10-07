import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PROJECT_ROOT, privateDirectory, writePrivateJson, extensionOrigin } from '../server/paths.mjs';
import { installPlan, launcherText } from '../server/platform.mjs';
import { privateWindowsPaths, registryEntries, updateRegistry, powershellJson } from '../server/windows-security.mjs';
import { NativeDecoder, nativeFrame } from '../server/framing.mjs';
const windows = { skip: process.platform !== 'win32', timeout: 25_000 };

test('Windows NTFS ownership and ACL deny a descriptor explicitly shared to another identity', windows, async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'lcc-acl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  const file = path.join(directory, 'descriptor.json'); await writePrivateJson(file, { example: true });
  assert.deepEqual(await privateWindowsPaths(directory, [file]), { directory: true, files: [file] });
  await powershellJson(`$acl=Get-Acl -LiteralPath $data.file; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow')); Set-Acl -LiteralPath $data.file -AclObject $acl; @{changed=$true} | ConvertTo-Json -Compress;`, { file });
  assert.deepEqual(await privateWindowsPaths(directory, [file]), { directory: true, files: [] });
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
  const plan = installPlan({ root: directory, project, node: process.execPath, host: 'com.localchrome.control', origin });
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
