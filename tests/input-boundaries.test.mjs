import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BrowserAdapter } from '../extension/browser-adapter.mjs';
import { Controller } from '../extension/controller.mjs';
import { snapshotPage, prepareAction, focusedElement, scrollMetrics } from '../extension/page-world.mjs';
import { ControlError } from '../extension/protocol.mjs';

const origin = 'https://example.test';
function harness(body) {
  const dom = new JSDOM('<!doctype html><body>' + body, { url: origin + '/', runScripts: 'outside-only' });
  const w = dom.window, commands = [];
  w.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 30 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let hit;
  w.document.elementFromPoint = () => hit;
  const evaluate = async (id, fn, params) => {
    try { return w.eval('(' + fn.toString() + ')(' + params.map(value => JSON.stringify(value)).join(',') + ')'); }
    catch (e) { throw new ControlError(e.message, e.message); }
  };
  const api = { tabs: { async get(id) { return { id, url: origin + '/' }; } }, debugger: {
    async attach() {}, async detach() {}, async getTargets() { return []; },
    async sendCommand(target, method, params) { commands.push({ method, params }); return {}; }
  } };
  const adapter = new BrowserAdapter(api); adapter.evaluate = evaluate;
  let saved = {};
  const controller = new Controller(adapter, { async loadLedger() { return saved; }, async saveLedger(value) { saved = structuredClone(value); } });
  const snapshot = () => evaluate(7, snapshotPage, [origin, 'snap', 24000, 250]);
  return { dom, w, api, adapter, controller, commands, evaluate, snapshot,
    hit(el) { hit = el; }, get saved() { return saved; },
    async scope() { await controller.grant({ id: 7, url: origin + '/' }); const lease = await controller.execute('tab_claim', { tab_id: 7, task_name: 'Regression' }); return { tab_id: 7, lease_id: lease.lease_id }; }
  };
}

test('open and closed shadow-root password focus cannot receive a character key', async t => {
  for (const mode of ['open', 'closed']) {
    const h = harness('<div id="host"></div>'); t.after(() => h.dom.window.close());
    const host = h.w.document.querySelector('#host'), shadow = host.attachShadow({ mode });
    shadow.innerHTML = '<input type="password" value="synthetic">'; shadow.querySelector('input').focus();
    const focus = await h.evaluate(7, focusedElement, [origin]);
    assert.equal(mode === 'open' ? focus.password : focus.unverified, true);
    const progress = { dispatched: false };
    await assert.rejects(h.adapter.run('page_press_key', { tab_id: 7, key: 'a' }, origin, Date.now() + 1000, async () => {}, progress), { code: mode === 'open' ? 'UNSUPPORTED_INPUT' : 'UNVERIFIED_FOCUS' });
    assert.equal(h.commands.length, 0); assert.equal(progress.dispatched, false);
    assert.equal(shadow.querySelector('input').value, 'synthetic');
  }
});

test('focus identity changes when another native element takes focus, even with matching labels', async t => {
  const h = harness('<input aria-label="Same"><input aria-label="Same">'); t.after(() => h.dom.window.close());
  const [a, b] = h.w.document.querySelectorAll('input'); a.focus();
  const first = await h.evaluate(7, focusedElement, [origin]); b.focus();
  const second = await h.evaluate(7, focusedElement, [origin]); assert.notEqual(first.focus_id, second.focus_id);
});

test('focus change during the asynchronous guard refuses character input', async t => {
  const h = harness('<input aria-label="Search"><input type="password" aria-label="Synthetic password">'); t.after(() => h.dom.window.close());
  const [a, b] = h.w.document.querySelectorAll('input'); a.focus(); let guards = 0;
  await assert.rejects(h.adapter.run('page_press_key', { tab_id: 7, key: 'a' }, origin, Date.now() + 1000,
    async () => { if (++guards === 2) b.focus(); }, {}), { code: 'UNSUPPORTED_INPUT' });
  assert.equal(h.commands.length, 0);
});

test('preflight is pure and rejects unsupported fill before scrolling or focusing', async t => {
  const h = harness('<input type="password">'); t.after(() => h.dom.window.close());
  const el = h.w.document.querySelector('input'); h.hit(el); await h.snapshot();
  let scrolls = 0, focuses = 0; el.scrollIntoView = () => scrolls++; el.addEventListener('focus', () => focuses++);
  await assert.rejects(h.evaluate(7, prepareAction, [origin, 'snap', 'e1', 'check-fill', 'x']), { code: 'UNSUPPORTED_INPUT' });
  assert.equal(scrolls, 0); assert.equal(focuses, 0);
});

test('a focus-triggered submission is unknown on failure and cannot be replayed', async t => {
  const h = harness('<form><input aria-label="Target"><input aria-label="Other"></form>'); t.after(() => h.dom.window.close());
  const [target, other] = h.w.document.querySelectorAll('input'); h.hit(target); await h.snapshot();
  let submits = 0;
  const form = h.w.document.querySelector('form'); form.addEventListener('submit', e => { e.preventDefault(); submits++; });
  target.addEventListener('focus', () => { form.requestSubmit(); other.focus(); });
  const scope = await h.scope(), args = { ...scope, snapshot_id: 'snap', ref: 'e1', key: 'Enter', request_id: 'focus-side-effect-01' };
  await assert.rejects(h.controller.execute('page_press_key', args), e => e.code === 'ACTION_STATUS_UNKNOWN' && e.details.executed !== false);
  assert.equal(h.saved[args.request_id].status, 'unknown'); assert.equal(submits, 1);
  await assert.rejects(h.controller.execute('page_press_key', args), { code: 'ACTION_STATUS_UNKNOWN' });
  assert.equal(submits, 1); assert.equal(h.commands.length, 0);
});

test('scroll-into-view side effects are also protected from replay after preparation failure', async t => {
  const h = harness('<button>Submit</button>'); t.after(() => h.dom.window.close());
  const button = h.w.document.querySelector('button'); await h.snapshot();
  let effects = 0; button.scrollIntoView = () => effects++; // No hit: preparation fails after scrolling.
  const scope = await h.scope(), args = { ...scope, snapshot_id: 'snap', ref: 'e1', request_id: 'scroll-preparation-01' };
  await assert.rejects(h.controller.execute('page_click', args), { code: 'ACTION_STATUS_UNKNOWN' });
  await assert.rejects(h.controller.execute('page_click', args), { code: 'ACTION_STATUS_UNKNOWN' });
  assert.equal(effects, 1); assert.equal(h.commands.length, 0);
});

test('password editing and submission keys are blocked; Tab can leave the field', async t => {
  const h = harness('<input type="password">'); t.after(() => h.dom.window.close()); h.w.document.querySelector('input').focus();
  for (const key of ['a', 'Backspace', 'Delete', 'Enter']) {
    await assert.rejects(h.adapter.run('page_press_key', { tab_id: 7, key }, origin, Date.now() + 1000, async () => {}, {}), { code: 'UNSUPPORTED_INPUT' });
  }
  assert.equal(h.commands.length, 0);
  await h.adapter.run('page_press_key', { tab_id: 7, key: 'Tab' }, origin, Date.now() + 1000, async () => {}, {});
  assert.equal(h.commands.length, 2);
});

test('unidentified body focus only permits Tab or Escape, not typing or implicit submission', async t => {
  const h = harness('<p>No identified focus</p>'); t.after(() => h.dom.window.close());
  for (const key of ['a', 'Enter', 'Backspace', 'End']) {
    await assert.rejects(h.adapter.run('page_press_key', { tab_id: 7, key }, origin, Date.now() + 1000, async () => {}, {}), { code: 'UNVERIFIED_FOCUS' });
  }
  assert.equal(h.commands.length, 0);
  await h.adapter.run('page_press_key', { tab_id: 7, key: 'Tab' }, origin, Date.now() + 1000, async () => {}, {});
  assert.equal(h.commands.length, 2);
});

function dimensions(el, values) { for (const [key, value] of Object.entries(values)) Object.defineProperty(el, key, { value, configurable: true }); }
function nested(h) {
  const outer = h.w.document.querySelector('#outer'), inner = h.w.document.querySelector('#inner'), button = h.w.document.querySelector('button');
  dimensions(outer, { clientWidth: 320, scrollWidth: 1000, clientHeight: 200, scrollHeight: 200 });
  dimensions(inner, { clientWidth: 300, scrollWidth: 300, clientHeight: 160, scrollHeight: 800 }); h.hit(button);
  return { outer, inner };
}
const nestedHTML = '<div id="outer" style="overflow-x:auto"><div id="inner" style="overflow-y:auto"><button>Target</button></div></div>';

test('horizontal wheel measures the outer horizontal container, not the vertical child', async t => {
  const h = harness(nestedHTML); t.after(() => h.dom.window.close()); const { outer } = nested(h); await h.snapshot();
  h.api.debugger.sendCommand = async (target, method, params) => { h.commands.push({ method, params }); outer.scrollLeft += params.deltaX || 0; return {}; };
  const result = await h.adapter.run('page_scroll', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', direction: 'right', amount: 180 }, origin, Date.now() + 3000, async () => {});
  assert.equal(result.moved, true); assert.equal(result.scroll_x, 180); assert.equal(result.scroll_width, 1000); assert.equal(result.reached_end, false);
});

test('vertical scrolling still chooses the inner container', async t => {
  const h = harness(nestedHTML); t.after(() => h.dom.window.close()); const { inner } = nested(h); await h.snapshot();
  h.api.debugger.sendCommand = async (target, method, params) => { inner.scrollTop += params.deltaY || 0; return {}; };
  const result = await h.adapter.run('page_scroll', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', direction: 'down', amount: 100 }, origin, Date.now() + 3000, async () => {});
  assert.equal(result.scroll_y, 100); assert.equal(result.scroll_height, 800); assert.equal(result.moved, true);
});

test('a scroll chain with multiple moving boxes reports an unknown boundary', async t => {
  const h = harness('<div id="outer" style="overflow-y:auto"><div id="inner" style="overflow-y:auto"><button>Target</button></div></div>'); t.after(() => h.dom.window.close());
  const { outer, inner } = nested(h); dimensions(outer, { clientHeight: 200, scrollHeight: 2000 }); await h.snapshot();
  h.api.debugger.sendCommand = async () => { inner.scrollTop = 640; outer.scrollTop = 100; return {}; };
  const result = await h.adapter.run('page_scroll', { tab_id: 7, snapshot_id: 'snap', ref: 'e1', direction: 'down' }, origin, Date.now() + 3000, async () => {});
  assert.equal(result.moved, true); assert.equal(result.container, 'multiple'); assert.equal(result.reached_end, null);
});

test('scroll tracking reports the ancestor that actually moved when the child is at its end', async t => {
  const h = harness('<div id="outer" style="overflow-y:auto"><div id="inner" style="overflow-y:auto"><button>Target</button></div></div>'); t.after(() => h.dom.window.close());
  const { outer, inner } = nested(h); dimensions(outer, { clientHeight: 200, scrollHeight: 2000 }); inner.scrollTop = 640; await h.snapshot();
  await h.evaluate(7, scrollMetrics, [origin, 'snap', 'e1', 'down', { x: 20, y: 20 }, 'track']); outer.scrollTop = 100;
  const after = await h.evaluate(7, scrollMetrics, [origin, 'snap', 'e1', 'down', { x: 20, y: 20 }, 'track']);
  assert.equal(after.y, 100); assert.equal(after.height, 2000); assert.equal(after.moved, true);
});

test('overscroll containment does not report an unreachable ancestor as the target', async t => {
  const h = harness('<div id="outer" style="overflow-y:auto"><div id="inner" style="overflow-y:auto;overscroll-behavior-y:contain"><button>Target</button></div></div>'); t.after(() => h.dom.window.close());
  const { outer, inner } = nested(h); dimensions(outer, { clientHeight: 200, scrollHeight: 2000 }); inner.scrollTop = 640; await h.snapshot();
  const before = await h.evaluate(7, scrollMetrics, [origin, 'snap', 'e1', 'down', { x: 20, y: 20 }, 'track-contained']);
  assert.equal(before.y, 640); assert.equal(before.height, 800); assert.equal(before.positions.length, 1);
});
