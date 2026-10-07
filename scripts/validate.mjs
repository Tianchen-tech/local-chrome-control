import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PROJECT_ROOT, extensionId } from '../server/paths.mjs';
import { HOST_NAME, VERSION } from '../extension/protocol.mjs';
import { TOOLS } from '../server/tools.mjs';
let checked = 0;
async function scan(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(item.name)) continue;
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await scan(filename);
    else if (filename.endsWith('.mjs')) {
      const run = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
      assert.equal(run.status, 0, filename + '\n' + run.stderr); checked++;
    }
  }
}
await scan(PROJECT_ROOT);
const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, VERSION);
assert.equal(manifest.background.type, 'module');
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'debugger', 'nativeMessaging', 'storage'].sort());
assert.match(extensionId(manifest.key), /^[a-p]{32}$/);
assert.match(HOST_NAME, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
for (const relative of [...Object.values(manifest.icons), manifest.action.default_popup, manifest.background.service_worker]) {
  await fs.access(path.join(PROJECT_ROOT, 'extension', relative));
}
assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length);
for (const tool of TOOLS) {
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const field of tool.inputSchema.required) assert.ok(tool.inputSchema.properties[field]);
}
console.log(JSON.stringify({ syntax_files_checked: checked, extension_id: extensionId(manifest.key), tool_count: TOOLS.length, status: 'passed' }, null, 2));
