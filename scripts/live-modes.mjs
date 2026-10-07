// Development acceptance client. Uses the same local bridge and consent/lease checks
// as MCP; it never grants a tab, changes a mode or replays an uncertain mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../extension/protocol.mjs';
import { bridgeCall, discover, publicSession } from '../server/bridge-client.mjs';
const [sessionId, mode, output, explicitTabId] = process.argv.slice(2);
if (explicitTabId !== undefined && (!/^\d+$/.test(explicitTabId) || !Number.isSafeInteger(Number(explicitTabId)))) throw new Error('Invalid explicit authorized tab ID');
if (!sessionId || !['readonly', 'standard', 'extended'].includes(mode) || !output) throw new Error('Usage: node scripts/live-modes.mjs SESSION_ID MODE OUTPUT_DIRECTORY [AUTHORIZED_TAB_ID]');
const names = { readonly: '只读', standard: '标准', extended: '扩展' };
const session = (await discover()).find(s => s.session_id === sessionId);
assert.ok(session, 'Selected Chrome session must exist');
assert.equal(publicSession(session).extension_version, VERSION);
const call = (method, args = {}) => bridgeCall(method, { session_id: sessionId, ...args });
const tab = (await call('tabs_list')).tabs.find(t => (explicitTabId ? t.tab_id === Number(explicitTabId) : t.title === `Local Chrome Control ${VERSION} · ${names[mode]}合成验收`) && t.origin === 'http://127.0.0.1:19320');
assert.ok(tab, 'User must authorize the exact synthetic tab in the popup');
assert.equal(tab.mode, mode, 'The user must select the intended mode');
if (mode === 'extended') { assert.equal(tab.scope_kind, 'all_websites_except_blocked'); assert.ok(!tab.blocked_sites.includes('localhost')); assert.ok(!tab.blocked_sites.includes('127.0.0.1')); }
const lease = await call('tab_claim', { tab_id: tab.tab_id, task_name: VERSION + ' ' + names[mode] + '合成验收' });
const base = { tab_id: tab.tab_id, lease_id: lease.lease_id };
let shot, sequence = 0;
const entries = [], directory = path.resolve(output);
await fs.mkdir(directory, { recursive: true });
const snapshot = async () => { shot = await call('page_snapshot', base); return shot; };
const record = (name, data = {}) => { entries.push({ name, ...data, at: new Date().toISOString() }); console.log(name); };
const ref = (label, frame = null) => { const el = shot.elements.find(e => e.label === label && (frame ? e.frame === frame : !e.frame)); assert.ok(el, 'Missing synthetic target: ' + label); return el.ref; };
async function act(method, label, value, frame = null, extra = {}) {
  const args = { ...base, snapshot_id: shot.snapshot_id, ref: ref(label, frame), request_id: 'modes-' + mode + '-' + Date.now() + '-' + (++sequence), ...(value !== undefined ? { value } : {}), ...extra };
  await fs.appendFile(path.join(directory, 'operations.jsonl'), JSON.stringify({ method, request_id: args.request_id, stage: 'before_dispatch', at: new Date().toISOString() }) + '\n');
  const result = await call(method, args);
  await fs.appendFile(path.join(directory, 'operations.jsonl'), JSON.stringify({ method, request_id: args.request_id, stage: 'acknowledged', elapsed_ms: result.elapsed_ms }) + '\n');
  await snapshot();
}
async function denied(method, args, code) {
  const request_id = 'deny-' + mode + '-' + Date.now() + '-' + (++sequence);
  let actual;
  try { await call(method, { ...base, snapshot_id: shot.snapshot_id, ref: ref('增加计数'), request_id, ...args }); }
  catch (error) { actual = error; }
  assert.equal(actual?.code, code);
  if (code === 'ACTION_STATUS_UNKNOWN') { const state = await call('request_status', { request_id }); assert.equal(state.status, 'unknown'); }
  await snapshot(); record(method + ' correctly rejected', { code });
}
try {
  await snapshot(); assert.equal(shot.title, `Local Chrome Control ${VERSION} · ${names[mode]}合成验收`, 'Snapshot must confirm the exact synthetic page before any edit'); record('fresh snapshot', { elements: shot.elements.length, frames: shot.frames });
  if (mode === 'readonly') {
    await denied('page_click', {}, 'READ_ONLY_MODE');
    await denied('page_fill', { value: 'No write' }, 'READ_ONLY_MODE');
    await denied('page_type_text', { value: 'No write' }, 'READ_ONLY_MODE');
    await denied('page_select', { value: 'No write' }, 'READ_ONLY_MODE');
    await denied('page_press_key', { key: 'Enter' }, 'READ_ONLY_MODE');
    await denied('page_scroll', { direction: 'down' }, 'READ_ONLY_MODE');
    await denied('page_navigate', { url: 'http://127.0.0.1:19320/next' }, 'READ_ONLY_MODE');
    assert.equal(shot.elements.find(e => e.label === '普通输入').value, '');
    assert.equal(shot.elements.find(e => e.label === '消息正文').value, '初始草稿');
    record('readonly left the form and draft unchanged');
  } else {
    await act('page_fill', '普通输入', '普通表单已填写'); assert.equal(shot.elements.find(e => e.label === '普通输入').value, '普通表单已填写'); record('native form fill');
    await act('page_fill', '消息正文', '中文草稿\n第二行'); assert.equal(shot.elements.find(e => e.label === '消息正文').value, '中文草稿 第二行'); assert.ok(shot.text.includes('浏览器真实输入：true')); record('rich text trusted Unicode multiline replacement');
    await act('page_type_text', '消息正文', '你好😀', null, { mode: 'characters' }); assert.ok(shot.elements.find(e => e.label === '消息正文').value.endsWith('你好😀')); record('rich text character-by-character insertion');
    await act('page_fill', '消息正文', ''); assert.equal(shot.elements.find(e => e.label === '消息正文').value, ''); record('rich editor clear');
    await act('page_fill', '消息正文', '合成测试草稿：富文本、菜单、Shadow DOM 与框架');
    for (const label of ['菜单动作', '标签动作', '选项动作', '链接动作']) { await act('page_click', label); assert.ok(shot.text.includes(label + '已点击')); record('role-only ' + label); }
    await act('page_fill', '影子输入', '开放 Shadow DOM 可填写'); assert.equal(shot.elements.find(e => e.label === '影子输入').value, '开放 Shadow DOM 可填写'); record('open shadow native input');
    const same = shot.elements.find(e => e.label === 'Same frame input'); assert.ok(same?.frame);
    await act('page_fill', 'Same frame input', '同源框架可填写', same.frame); assert.equal(shot.elements.find(e => e.label === 'Same frame input').value, '同源框架可填写'); record('same-origin frame fill');
    await act('page_click', '框架计数', undefined, same.frame); assert.match(shot.text, /同源框架[\s\S]*框架计数[\s\S]*1/); record('same-origin frame click');
    if (mode === 'standard') {
      assert.ok(!shot.elements.some(e => e.label === 'Cross frame input')); record('cross-origin frame DOM withheld');
      await denied('page_navigate', { url: 'http://localhost:19321/second' }, 'ORIGIN_NOT_AUTHORIZED');
    } else {
      const cross = shot.elements.find(e => e.label === 'Cross frame input'); assert.ok(cross?.frame);
      await act('page_fill', 'Cross frame input', '跨进程框架可填写', cross.frame); assert.equal(shot.elements.find(e => e.label === 'Cross frame input').value, '跨进程框架可填写'); record('authorized cross-origin frame fill');
      await act('page_click', '框架计数', undefined, cross.frame); assert.match(shot.text, /跨源框架[\s\S]*框架计数[\s\S]*1/); record('authorized cross-origin frame click');
      const request_id = 'navigate-' + Date.now();
      await call('page_navigate', { ...base, request_id, url: 'http://localhost:19321/second?mode=extended' });
      // Navigation completion is observed before reading; no mutation is replayed.
      let arrived = false;
      for (let i = 0; i < 20; i++) {
        const current = (await call('tabs_list')).tabs.find(t => t.tab_id === base.tab_id);
        if (current?.origin === 'http://localhost:19321') { arrived = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(arrived, 'Allowed navigation must retain the authorized tab'); await snapshot();
      assert.ok(shot.title.includes('第二')); await act('page_fill', '普通输入', '跨站后无需重新授权'); record('cross-site navigation without URL entry and subsequent fill with the same task lease');
    }
  }
  const picture = await call('page_screenshot', base);
  await fs.writeFile(path.join(directory, mode + '.jpg'), Buffer.from(picture.data, 'base64'));
  await fs.writeFile(path.join(directory, mode + '-snapshot.json'), JSON.stringify(shot, null, 2));
  record('page screenshot saved');
} catch (error) {
  record('acceptance stopped; no automatic write replay', { code: error.code || error.name, message: error.message, details: error.details });
  if (error.details?.request_id) {
    const state = await call('request_status', { request_id: error.details.request_id }).catch(() => null);
    await fs.writeFile(path.join(directory, mode + '-failure-status.json'), JSON.stringify(state, null, 2));
  }
  const observed = await snapshot().catch(() => null);
  if (observed) await fs.writeFile(path.join(directory, mode + '-failure-snapshot.json'), JSON.stringify(observed, null, 2));
  process.exitCode = 1;
} finally {
  await call('tab_release', base).catch(() => {});
  await fs.writeFile(path.join(directory, mode + '-results.json'), JSON.stringify({ mode, tab_id: tab.tab_id, entries, passed: !process.exitCode }, null, 2));
}
