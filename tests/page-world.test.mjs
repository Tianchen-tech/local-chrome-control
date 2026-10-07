import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { snapshotPage, prepareAction, focusedElement, scrollMetrics } from '../extension/page-world.mjs';
function page(body) {
  const dom = new JSDOM('<!doctype html><title>Fixture</title><body>' + body, { url: 'https://example.test/form', runScripts: 'outside-only' });
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 30 });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let top = null;
  w.document.elementFromPoint = () => top;
  const call = (fn, args) => w.eval('(' + fn.toString() + ')(' + args.map(x => JSON.stringify(x)).join(',') + ')');
  return { w, dom, top(el) { top = el; }, snapshot(id = 'snapshot-one') { return call(snapshotPage, ['https://example.test', id, 24000, 250]); },
    act(id, ref, op, value = '') { return call(prepareAction, ['https://example.test', id, ref, op, value]); },
    focused() { return call(focusedElement, ['https://example.test']); },
    scroll(id = '', ref = '') { return call(scrollMetrics, ['https://example.test', id, ref]); } };
}
test('snapshot lists only visible controls and masks passwords', () => {
  const p = page('<input type="hidden" value="secret-token"><input aria-label="Password" type="password" value="secret-password"><button hidden>Hidden</button><button aria-label="Read me">OK</button>');
  const s = p.snapshot();
  assert.equal(s.elements.length, 2); assert.equal(s.elements[0].value, '[redacted]');
  assert.ok(!JSON.stringify(s).includes('secret-')); assert.equal(s.elements[1].label, 'Read me');
  p.dom.window.close();
});
test('stale snapshots and disconnected elements cannot be used', () => {
  const p = page('<button>Submit</button>'); p.top(p.w.document.querySelector('button'));
  p.snapshot(); p.snapshot('snapshot-two');
  assert.throws(() => p.act('snapshot-one', 'e1', 'point'), /STALE_SNAPSHOT/);
  p.w.document.querySelector('button').remove();
  assert.throws(() => p.act('snapshot-two', 'e1', 'point'), /STALE_REF/); p.dom.window.close();
});
test('changed labels and overlays cannot redirect a click', () => {
  const p = page('<button>Submit</button><div id="overlay">Cover</div>'); const button = p.w.document.querySelector('button');
  p.top(button); p.snapshot(); button.textContent = 'Pay now';
  assert.throws(() => p.act('snapshot-one', 'e1', 'point'), /ELEMENT_CHANGED/);
  p.snapshot('new'); p.top(p.w.document.getElementById('overlay'));
  assert.throws(() => p.act('new', 'e1', 'point'), /ELEMENT_OBSCURED/); p.dom.window.close();
});
test('point remeasurement is pure and does not repeat scrollIntoView on sticky navigation', () => {
  const p = page('<button>Menu</button>'), button = p.w.document.querySelector('button');
  let scrolls = 0;
  button.scrollIntoView = () => { scrolls++; };
  p.top(button); p.snapshot();
  p.act('snapshot-one', 'e1', 'point');
  p.act('snapshot-one', 'e1', 'measure-point'); p.act('snapshot-one', 'e1', 'measure-point');
  assert.equal(scrolls, 1);
  p.top(p.w.document.body); assert.throws(() => p.act('snapshot-one', 'e1', 'measure-point'), /ELEMENT_OBSCURED/);
  p.dom.window.close();
});
test('a main-page iframe wrapper cannot bypass routed frame permissions with click or wheel input', () => {
  const p = page('<div role="button" aria-label="Wrapper"><iframe tabindex="0" src="https://blocked.test"></iframe></div>');
  const iframe = p.w.document.querySelector('iframe'); p.top(iframe);
  const shot = p.snapshot();
  const ownRef = shot.elements.find(e => e.tag === 'iframe').ref;
  const parentRef = shot.elements.find(e => e.label === 'Wrapper').ref;
  assert.throws(() => p.act('snapshot-one', ownRef, 'check-point'), /FRAME_TARGET_REQUIRED/);
  assert.throws(() => p.act('snapshot-one', parentRef, 'point'), /FRAME_TARGET_REQUIRED/);
  assert.throws(() => p.scroll(), /FRAME_TARGET_REQUIRED/);
  p.dom.window.close();
});
test('fill uses the native setter and emits input/change exactly once', () => {
  const p = page('<label>Name<input type="text"></label>'); const input = p.w.document.querySelector('input');
  p.top(input); p.snapshot(); const events = [];
  input.addEventListener('input', () => events.push('input')); input.addEventListener('change', () => events.push('change'));
  p.act('snapshot-one', 'e1', 'fill', '测试 Alice');
  assert.equal(input.value, '测试 Alice'); assert.deepEqual(events, ['input', 'change']); p.dom.window.close();
});
test('password and file fill is unsupported', () => {
  for (const type of ['password', 'file']) {
    const p = page('<input type="' + type + '">'); p.top(p.w.document.querySelector('input')); p.snapshot();
    assert.throws(() => p.act('snapshot-one', 'e1', 'fill', 'x'), /UNSUPPORTED_INPUT/); p.dom.window.close();
  }
});
test('native select rejects absent or disabled options', () => {
  const p = page('<select><option value="100">100M</option><option value="500">500M</option><option value="1000" disabled>1G</option></select>');
  const select = p.w.document.querySelector('select'); p.top(select); const s = p.snapshot();
  assert.equal(s.elements[0].options[1].value, '500');
  p.act('snapshot-one', 'e1', 'select', '500'); assert.equal(select.value, '500');
  assert.throws(() => p.act('snapshot-one', 'e1', 'select', '1000'), /INVALID_OPTION/); p.dom.window.close();
});
test('origin check precedes page access', () => {
  const p = page('<button>OK</button>');
  p.dom.reconfigure({ url: 'https://different.test/' });
  assert.throws(() => p.snapshot(), /ORIGIN_CHANGED/); p.dom.window.close();
});
test('unchanged labels cannot hide a changed link or form destination', () => {
  const link = page('<a href="/review">Continue</a>');
  const a = link.w.document.querySelector('a'); link.top(a); link.snapshot(); a.href = '/confirm';
  assert.throws(() => link.act('snapshot-one', 'e1', 'point'), /ELEMENT_CHANGED/);
  link.dom.window.close();
  const form = page('<form action="/review"><button>Continue</button></form>');
  form.top(form.w.document.querySelector('button')); form.snapshot();
  form.w.document.querySelector('form').action = '/confirm';
  assert.throws(() => form.act('snapshot-one', 'e1', 'point'), /ELEMENT_CHANGED/);
  form.dom.window.close();
});
test('changed plan options require a new snapshot and disabled groups stay disabled', () => {
  const p = page('<select><option value="500">500M, $40</option><optgroup disabled><option value="1000">1G</option></optgroup></select>');
  const select = p.w.document.querySelector('select'); p.top(select);
  const s = p.snapshot();
  assert.equal(s.elements[0].options[1].disabled, true);
  assert.throws(() => p.act('snapshot-one', 'e1', 'select', '1000'), /INVALID_OPTION/);
  select.options[0].textContent = '500M, $80';
  assert.throws(() => p.act('snapshot-one', 'e1', 'select', '500'), /ELEMENT_CHANGED/);
  p.dom.window.close();
});
test('focus moves keyboard focus only to focusable elements', () => {
  const p = page('<input aria-label="搜索"><div role="button" tabindex="0">Menu</div>');
  const [input, div] = p.w.document.querySelectorAll('input, div');
  p.top(input); p.snapshot();
  assert.equal(p.act('snapshot-one', 'e1', 'focus').focused, true);
  assert.equal(p.w.document.activeElement, input);
  div.focus = () => {}; p.top(div);
  assert.throws(() => p.act('snapshot-one', 'e2', 'focus'), /NOT_FOCUSABLE/); p.dom.window.close();
});
test('focused element report names the target without reading values', () => {
  const p = page('<input type="password" aria-label="Password" value="secret-password"><iframe title="pay"></iframe>');
  assert.equal(p.focused(), null);
  p.snapshot(); p.w.document.querySelector('input').focus();
  const target = p.focused();
  assert.equal(target.password, true); assert.equal(target.ref, 'e1'); assert.ok(!JSON.stringify(target).includes('secret'));
  p.w.document.querySelector('iframe').focus();
  assert.equal(p.focused().frame, true); p.dom.window.close();
});
test('focused element report flags video players', () => {
  const p = page('<div id="player" tabindex="0" aria-label="Video player"><video></video></div><button>Play</button>');
  p.w.document.getElementById('player').focus();
  assert.equal(p.focused().media, true);
  p.w.document.querySelector('button').focus();
  assert.equal(p.focused().media, false); p.dom.window.close();
});
test('scroll metrics measure the page and reject stale refs', () => {
  const p = page('<button>OK</button>'); p.snapshot();
  assert.equal(p.scroll().container, 'page');
  assert.equal(p.scroll('snapshot-one', 'e1').container, 'page');
  assert.throws(() => p.scroll('old', 'e1'), /STALE_SNAPSHOT/); p.dom.window.close();
});
