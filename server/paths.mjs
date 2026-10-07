import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtimeDirectory } from './platform.mjs';
import { secureWindowsDirectory, secureWindowsFile, privateWindowsPaths } from './windows-security.mjs';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export function runtimeRoot() {
  return runtimeDirectory();
}
export async function privateDirectory(directory = runtimeRoot()) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_RUNTIME_DIRECTORY');
  if (process.platform === 'win32') await secureWindowsDirectory(directory);
  else {
    if (stat.uid !== process.getuid()) throw new Error('UNSAFE_RUNTIME_DIRECTORY');
    await fs.chmod(directory, 0o700);
  }
  return directory;
}
export async function privatePaths(directory, files = []) {
  if (process.platform === 'win32') return privateWindowsPaths(directory, files);
  const safe = async (filename, folder) => {
    try { const stat = await fs.lstat(filename); return !stat.isSymbolicLink() &&
      (folder ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid() && !(stat.mode & 0o077); }
    catch { return false; }
  };
  return { directory: await safe(directory, true), files: (await Promise.all(files.map(async f => await safe(f, false) ? f : null))).filter(Boolean) };
}
export function extensionId(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
export async function extensionOrigin() {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('EXTENSION_KEY_NOT_BOUND: bind the selected extension public key before installing.');
  return 'chrome-extension://' + extensionId(manifest.key) + '/';
}
export async function writePrivateJson(filename, value) {
  const temp = filename + '.' + process.pid + '.tmp';
  let created = false;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    created = true;
    if (process.platform === 'win32') await secureWindowsFile(temp);
    await fs.rename(temp, filename);
  } finally { if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
