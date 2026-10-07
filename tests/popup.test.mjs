import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await fs.readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = await fs.readFile(new URL('../extension/popup.mjs', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function popup(onMessage = async () => ({ ok: true })) {
  const state = { connected: true, session_id: 'abcdef123456', connection_error: '', grants: [], pending_tab_ids: [], recent: [],
    current: { id: 7, title: 'Fixture', url: 'https://example.test', allowed: true } };
  const dom = new JSDOM(html, { url: 'https://extension.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  w.setInterval = () => 0;
  w.chrome = { runtime: { sendMessage: async message => message.type === 'popup-status' ? state : onMessage(message, state) } };
  w.eval(script + '\nwindow.__refreshForTest = refresh;');
  await flush();
  return { dom, state, el: id => w.document.getElementById(id), refresh: () => w.__refreshForTest() };
}
test('mode selection survives polling and is sent only with the user grant click', async () => {
  const sent = [], p = await popup(async message => { sent.push(message); return { ok: true }; });
  p.el('mode').value = 'extended'; p.el('mode').dispatchEvent(new p.dom.window.Event('input'));
  p.el('blocked-sites').value = 'example.net\nhttps://mail.example.org/inbox';
  await p.refresh(); assert.equal(sent.length, 0); assert.equal(p.el('mode').value, 'extended');
  p.el('grant').click(); await flush();
  assert.equal(sent[0].options.mode, 'extended'); assert.deepEqual(Array.from(sent[0].options.blocked_sites), ['example.net', 'https://mail.example.org/inbox']);
  assert.equal(Object.hasOwn(sent[0].options, 'origins'), false); p.dom.window.close();
});
test('readonly hides exclusions and never transmits stale high-tier settings', async () => {
  const sent = [], p = await popup(async message => { sent.push(message); return { ok: true }; });
  p.el('blocked-sites').value = 'other.test';
  p.el('mode').value = 'readonly'; p.el('mode').dispatchEvent(new p.dom.window.Event('input'));
  assert.equal(p.el('extended-fields').hidden, true);
  p.el('grant').click(); await flush();
  assert.equal(sent[0].options.mode, 'readonly'); assert.equal(sent[0].options.blocked_sites.length, 0);
  p.dom.window.close();
});
test('extended tier grants with an empty blacklist without entering any URLs', async () => {
  const sent = [], p = await popup(async message => { sent.push(message); return { ok: true }; });
  p.el('mode').value = 'extended'; p.el('mode').dispatchEvent(new p.dom.window.Event('input'));
  assert.equal(p.el('origins'), null); assert.equal(p.el('frame-origins'), null);
  p.el('grant').click(); await flush();
  assert.equal(sent[0].options.mode, 'extended'); assert.equal(sent[0].options.blocked_sites.length, 0);
  p.dom.window.close();
});
test('remembered mode and exclusions prefill new tabs without automatically granting them', async () => {
  const sent = [], p = await popup(async message => { sent.push(message); return { ok: true }; });
  p.state.preferences = { mode: 'extended', minutes: 60, blocked_sites: ['example.net'] };
  p.state.current.id = 8; await p.refresh(); await p.refresh();
  assert.equal(p.el('mode').value, 'extended'); assert.equal(p.el('blocked-sites').value, 'example.net');
  assert.equal(p.el('minutes').value, '60'); assert.equal(p.el('permission').textContent, '尚未授权'); assert.equal(sent.length, 0);
  p.state.grants = [{ tab_id: 8, mode: 'extended', blocked_sites: ['different.test'], authorization_minutes: 30, authorization_expires_at: Date.now() + 60000 }];
  await p.refresh(); assert.equal(p.el('blocked-sites').value, 'different.test');
  assert.match(p.el('scope-summary').textContent, /所有普通网站，排除 1 个域名/);
  p.dom.window.close();
});
test('popup reports connection and control separately; stopping works without a bridge', async () => {
  const p = await popup();
  assert.equal(p.el('grant').disabled, false);
  assert.equal(p.el('stop').hidden, true);
  assert.equal(p.el('session-id').textContent, '连接 ID · abcdef123456');
  p.state.connected = false; p.state.connection_error = '本地连接已断开';
  p.state.grants = [{ tab_id: 7, controlled_by: 'Fixture task' }];
  await p.refresh();
  assert.equal(p.el('status').textContent, '本地连接未就绪');
  assert.equal(p.el('connection-note').textContent, '本地连接已断开');
  assert.equal(p.el('permission').textContent, '控制中 · Fixture task');
  assert.equal(p.el('stop').hidden, false);
  assert.equal(p.el('stop').disabled, false);
  assert.equal(p.el('stop-all').disabled, false);
  p.dom.window.close();
});
test('popup renders page titles and task names as plain text', async () => {
  const p = await popup();
  p.state.current.title = '<img src=x onerror=alert(1)>';
  p.state.grants = [{ tab_id: 7, controlled_by: '<script>bad()</script>' }];
  p.state.recent = [{ method: 'page_fill', code: 'OK', elapsed_ms: 245 }];
  await p.refresh();
  assert.equal(p.el('tab-title').children.length, 0);
  assert.equal(p.el('permission').children.length, 0);
  assert.match(p.el('tab-title').textContent, /<img/);
  assert.match(p.el('events').textContent, /245 ms/);
  p.dom.window.close();
});
test('user can stop a grant that is still waiting for Chrome', async () => {
  let completeGrant; const sent = [];
  const p = await popup(async (message, state) => {
    sent.push(message.type);
    if (message.type === 'popup-grant') {
      state.pending_tab_ids = [7];
      return new Promise(resolve => { completeGrant = resolve; });
    }
    if (message.type === 'popup-stop-all') {
      state.pending_tab_ids = [];
      completeGrant({ error: { message: '授权已停止' } });
    }
    return { ok: true };
  });
  p.el('grant').click(); await flush(); await p.refresh();
  assert.equal(p.el('stop-all').disabled, false);
  p.el('stop-all').click(); await flush();
  assert.deepEqual(sent, ['popup-grant', 'popup-stop-all']);
  assert.equal(p.el('grant').hidden, false);
  p.dom.window.close();
});
