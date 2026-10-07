import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { snapshotPage, prepareAction, focusedElement } from '../extension/page-world.mjs';
import { BrowserAdapter } from '../extension/browser-adapter.mjs';
import { ControlError } from '../extension/protocol.mjs';
const origin = 'https://example.test';
function page(body) {
  const dom = new JSDOM('<body>' + body, { url: origin + '/', runScripts: 'outside-only' }), w = dom.window;
  w.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 30 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let top; w.document.elementFromPoint = () => top;
  const evaluate = async (id, fn, params) => {
    try { return w.eval('(' + fn.toString() + ')(' + params.map(x => JSON.stringify(x)).join(',') + ')'); }
    catch (e) { throw new ControlError(e.message, e.message); }
  };
  const commands = [];
  let closed = false, afterInsert = () => {};
  const adapter = new BrowserAdapter({ debugger: { async sendCommand(target, method, params) {
    commands.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { objectId: 'editor' } };
    if (method === 'DOM.describeNode') return { node: { nodeType: 1, shadowRoots: closed ? [{ shadowRootType: 'closed' }] : [] } };
    if (method === 'Input.insertText') afterInsert(params.text);
    return {};
  } } });
  adapter.evaluate = evaluate; adapter.world = async () => 1;
  return { dom, w, adapter, commands, evaluate, hit(el) { top = el; }, closed() { closed = true; }, inserted(fn) { afterInsert = fn; },
    snapshot() { return evaluate(7, snapshotPage, [origin, 'snap', 24000, 250]); } };
}
test('role-only menus, tabs, options and links are discovered without tabindex', async t => {
  const p = page('<div role="menuitem">菜单</div><div role="tab">标签</div><div role="option">选项</div><div role="link">链接</div>'); t.after(() => p.dom.window.close());
  const shot = await p.snapshot(); assert.deepEqual(Array.from(shot.elements, e => e.role), ['menuitem', 'tab', 'option', 'link']);
  assert.deepEqual(Array.from(shot.elements, e => e.label), ['菜单', '标签', '选项', '链接']);
});
test('empty and plaintext-only editable attributes are recognized; false editable remains noneditable', async t => {
  const p = page('<div contenteditable></div><div contenteditable="plaintext-only"></div><div contenteditable="false"></div>'); t.after(() => p.dom.window.close());
  const shot = await p.snapshot(); assert.equal(shot.elements.length, 2); assert.ok(shot.elements.every(e => e.editable));
});
test('open shadow native controls are collected, focused and targeted through the composed tree', async t => {
  const p = page('<div id="host"></div>'); t.after(() => p.dom.window.close());
  const host = p.w.document.getElementById('host'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<input aria-label="Shadow input">'; const input = root.querySelector('input');
  p.hit(host); root.elementFromPoint = () => input;
  const shot = await p.snapshot(); assert.equal(shot.elements[0].shadow, 'open');
  await p.evaluate(7, prepareAction, [origin, 'snap', 'e1', 'fill', 'Shadow works']);
  assert.equal(input.value, 'Shadow works');
  const focus = await p.evaluate(7, focusedElement, [origin, 'snap', 'e1']); assert.equal(focus.tag, 'input'); assert.equal(focus.unverified, false);
});
test('a hidden host suppresses its shadow controls and changed visibility rejects old references', async t => {
  const p = page('<div id="host"></div>'); t.after(() => p.dom.window.close());
  const host = p.w.document.getElementById('host'), root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<button>Inside</button>';
  await p.snapshot(); host.hidden = true;
  await assert.rejects(p.evaluate(7, prepareAction, [origin, 'snap', 'e1', 'check-point', '']), { code: 'ELEMENT_HIDDEN' });
  assert.equal((await p.snapshot()).elements.length, 0);
});
test('rich fill selects the target contents without changing DOM; trusted input is sent separately', async t => {
  const p = page('<div contenteditable="true" tabindex="0" aria-label="Editor">Existing</div>'); t.after(() => p.dom.window.close());
  const el = p.w.document.querySelector('div'); p.hit(el); await p.snapshot();
  let inputs = 0; el.addEventListener('input', () => inputs++);
  await p.adapter.run('page_fill', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', value: '中文\nSecond line' }, origin, Date.now() + 1000, async () => {}, {});
  assert.equal(el.textContent, 'Existing'); assert.equal(inputs, 0);
  assert.equal(p.w.document.getSelection().toString(), 'Existing');
  assert.deepEqual(p.commands.filter(c => c.method === 'Input.insertText').map(c => c.params.text), ['中文\nSecond line']);
});
test('character mode sends Unicode code points in sequence and stops after a focus theft', async t => {
  const p = page('<div contenteditable tabindex="0">Before</div><input type="password">'); t.after(() => p.dom.window.close());
  const el = p.w.document.querySelector('div'); p.hit(el); await p.snapshot();
  await p.adapter.run('page_type_text', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', value: '你好😀', mode: 'characters' }, origin, Date.now() + 1000, async () => {}, {});
  assert.deepEqual(p.commands.filter(c => c.method === 'Input.insertText').map(c => c.params.text), ['你', '好', '😀']);
  p.commands.length = 0; p.inserted(() => p.w.document.querySelector('input').focus());
  await assert.rejects(p.adapter.run('page_type_text', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', value: 'AB', mode: 'characters' }, origin, Date.now() + 1000, async () => {}, {}), { code: 'FOCUS_CHANGED' });
  assert.equal(p.commands.filter(c => c.method === 'Input.insertText').length, 1);
});
test('an editable-looking host with a closed shadow root cannot receive text', async t => {
  const p = page('<div contenteditable tabindex="0">Editor</div>'); t.after(() => p.dom.window.close());
  p.hit(p.w.document.querySelector('div')); await p.snapshot(); p.closed();
  await assert.rejects(p.adapter.run('page_fill', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', value: 'Do not enter' }, origin, Date.now() + 1000, async () => {}, {}), { code: 'UNVERIFIED_FOCUS' });
  assert.equal(p.commands.filter(c => c.method.startsWith('Input.')).length, 0);
});
