import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT } from '../server/paths.mjs';
import { sourceZip } from '../server/zip.mjs';
import { VERSION } from '../extension/protocol.mjs';
const output = path.join(PROJECT_ROOT, 'dist');
await fs.mkdir(output, { recursive: true });
const filename = path.join(output, 'local-chrome-control-' + VERSION + '-store-companion.zip');
const sources = ['.codex-plugin', '.mcp.json', '.github', 'extension', 'server', 'scripts', 'skills', 'assets', 'docs', 'tests', 'README.md', 'package.json', 'package-lock.json', '.gitignore'];
const files = [];
async function collect(relative) {
  const stat = await fs.lstat(path.join(PROJECT_ROOT, relative));
  if (stat.isSymbolicLink()) throw new Error('Refusing to package symlink: ' + relative);
  if (stat.isDirectory()) {
    for (const item of (await fs.readdir(path.join(PROJECT_ROOT, relative))).sort()) await collect(path.join(relative, item));
  } else {
    const name = relative.split(path.sep).join('/');
    // Never distribute this Mac's absolute MCP paths. prepare:local regenerates
    // machine-specific paths before installation on the recipient's computer.
    const data = name === '.mcp.json' ? Buffer.from(JSON.stringify({ mcpServers: { local_chrome: {
      command: 'node', args: ['${PLUGIN_ROOT}/server/mcp.mjs'], cwd: '${PLUGIN_ROOT}'
    } } }, null, 2) + '\n') : await fs.readFile(path.join(PROJECT_ROOT, relative));
    files.push({ name, data });
  }
}
for (const source of sources) await collect(source);
const bytes = sourceZip(files);
await fs.writeFile(filename, bytes);
const digest = createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(filename + '.sha256', digest + '  ' + path.basename(filename) + '\n');
console.log(JSON.stringify({ archive: filename, bytes: bytes.length, files: files.length, sha256: digest }, null, 2));
