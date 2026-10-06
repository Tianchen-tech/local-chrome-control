import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export function runtimeRoot() {
  return process.env.LOCAL_CHROME_CONTROL_DIR || path.join(homedir(), 'Library', 'Application Support', 'LocalChromeControl');
}
export async function privateDirectory(directory = runtimeRoot()) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('UNSAFE_RUNTIME_DIRECTORY');
  await fs.chmod(directory, 0o700);
  return directory;
}
export function extensionId(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
export async function extensionOrigin() {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('STORE_KEY_NOT_BOUND: publisher must bind the Chrome Web Store public key before installing.');
  return 'chrome-extension://' + extensionId(manifest.key) + '/';
}
export async function writePrivateJson(filename, value) {
  const temp = filename + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, filename);
}
