import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sourceZip } from '../server/zip.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');
const files = [];
async function collect(relative = '') {
  for (const name of (await fs.readdir(path.join(extension, relative))).sort()) {
    if (name === '.DS_Store') continue;
    const local = path.join(relative, name), item = path.join(extension, local), stat = await fs.lstat(item);
    if (stat.isSymbolicLink()) throw new Error('Refusing to package an extension symlink.');
    if (stat.isDirectory()) await collect(local);
    else {
      let data = await fs.readFile(item);
      if (local === 'manifest.json') {
        const manifest = JSON.parse(data); delete manifest.key;
        data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      }
      files.push({name: local.split(path.sep).join('/'), data});
    }
  }
}
await collect();
const manifest = JSON.parse(files.find(f => f.name === 'manifest.json').data);
const output = path.join(root, 'dist', 'local-chrome-control-' + manifest.version + '-chrome-store.zip');
await fs.mkdir(path.dirname(output), {recursive: true});
const bytes = sourceZip(files), sha256 = createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(output, bytes);
await fs.writeFile(output + '.sha256', sha256 + '  ' + path.basename(output) + '\n');
console.log(JSON.stringify({archive: output, files: files.length, bytes: bytes.length, sha256}, null, 2));
