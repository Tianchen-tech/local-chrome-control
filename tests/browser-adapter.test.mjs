import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAdapter } from '../extension/browser-adapter.mjs';
import { ControlError } from '../extension/protocol.mjs';

function adapter(commands = async () => ({})) {
  const calls = [];
  const api = { tabs: { async get(id) { return { id, url: 'https://example.test/' }; } }, debugger: {
    async attach() {}, async detach() {}, async getTargets() { return []; },
    async sendCommand(target, method, params) { calls.push({ target, method, params }); return commands(method, params); }
  } };
  return { api, calls, browser: new BrowserAdapter(api) };
}
test('fresh user grant can recover its own surviving attachment, but not another debugger', async () => {
  const h = adapter();
  h.api.debugger.attach = async () => { throw new Error('already attached'); };
  await h.browser.attach(7);
  assert.equal(h.calls[0].method, 'Page.getFrameTree');
  h.api.debugger.sendCommand = async () => { throw new Error('not attached to this target'); };
  await assert.rejects(h.browser.attach(7), { code: 'DEBUGGER_ATTACH_FAILED' });
});
test('lost execution context invalidates cache without replaying the failed command', async () => {
  const h = adapter(async () => { throw new Error('Cannot find context with specified id'); });
  h.browser.worlds.set(7, 15);
  await assert.rejects(h.browser.cdp(7, 'Runtime.evaluate', {}, Date.now() + 1000), { code: 'CONTEXT_LOST' });
  assert.equal(h.browser.worlds.has(7), false);
  assert.equal(h.calls.length, 1);
});
test('snapshot uses a main-frame isolated world with no universal access', async () => {
  const h = adapter(async method => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate') return { result: { value: { snapshot_id: 'mock-snapshot' } } };
    throw new Error('unexpected command');
  });
  const result = await h.browser.run('page_snapshot', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {});
  assert.equal(result.snapshot_id, 'mock-snapshot');
  assert.deepEqual(h.calls[1].params, { frameId: 'main-frame', worldName: 'local-chrome-control-v1', grantUniveralAccess: false });
  assert.equal(h.calls[2].params.contextId, 42);
  assert.equal(h.calls[2].params.returnByValue, true);
});
test('a moving target sends no click but tracks side-effecting preparation', async () => {
  const h = adapter(); let reads = 0;
  h.browser.evaluate = async (id, fn, params) => ['point', 'measure-point'].includes(params[3]) ? { x: reads++ ? 80 : 10, y: 10 } : { checked: true };
  const progress = { dispatched: false };
  await assert.rejects(h.browser.run('page_click', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {}, progress), { code: 'ELEMENT_MOVED' });
  assert.equal(h.calls.length, 0);
  assert.equal(progress.dispatched, true);
});
test('lost mouse-press reply still releases once and never repeats the click', async () => {
  const h = adapter(async (method, params) => {
    if (params.type === 'mousePressed') throw new Error('connection reset');
    return {};
  });
  h.browser.evaluate = async () => ({ x: 10, y: 10 });
  const progress = { dispatched: false };
  await assert.rejects(h.browser.run('page_click', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {}, progress), { code: 'BROWSER_COMMAND_FAILED' });
  assert.deepEqual(h.calls.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(h.calls.map(c => c.params.buttons), [0, 1, 0]);
  assert.equal(progress.dispatched, true);
});
test('click sends hover then pressed/released button state and rechecks hover changes before pressing', async () => {
  const h = adapter(); let points = 0;
  h.browser.evaluate = async (id, fn, params) => ['point', 'measure-point'].includes(params[3]) ? { x: ++points < 3 ? 10 : 60, y: 10 } : { checked: true };
  const progress = { dispatched: false };
  await assert.rejects(h.browser.run('page_click', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {}, progress), { code: 'ELEMENT_MOVED' });
  assert.deepEqual(h.calls.map(c => c.params.type), ['mouseMoved']);
  assert.equal(progress.dispatched, true);
});
test('missing cross-origin tab URL and title are recovered from only the attached target', async () => {
  const h = adapter(async method => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: 'https://other.test/next' } } };
    assert.equal(method, 'Target.getTargetInfo');
    return { targetInfo: { type: 'page', url: 'https://other.test/next', title: 'Other site' } };
  });
  h.api.tabs = { async get(id) { return { id, active: true }; } }; h.browser.frames.enabled.add(7);
  assert.deepEqual(await h.browser.tab(7), { id: 7, active: true, url: 'https://other.test/next', title: 'Other site' });
  assert.deepEqual(h.calls[0].target, { tabId: 7 });
  assert.deepEqual(h.calls[0].params, {});
  h.browser.frames.enabled.delete(7); h.calls.length = 0;
  await h.browser.tab(7); assert.equal(h.calls.length, 0, 'unauthorized tabs cannot use debugger metadata fallback');
});
test('a transient empty TargetInfo URL does not replace the committed frame URL or a permitted tab URL', async () => {
  const h = adapter(async method => method === 'Page.getFrameTree' ? { frameTree: { frame: { url: 'https://other.test/next' } } } : { targetInfo: { type: 'page', url: '', title: 'New page' } });
  h.api.tabs = { async get(id) { return { id }; } }; h.browser.frames.enabled.add(7);
  assert.equal((await h.browser.tab(7)).url, 'https://other.test/next');
  h.api.tabs.get = async id => ({ id, url: 'https://other.test/committed' });
  assert.equal((await h.browser.tab(7)).url, 'https://other.test/committed');
});
test('click scrolls once and its later pre-press checks only measure the same reference', async () => {
  const h = adapter(), operations = [];
  h.browser.evaluate = async (id, fn, params) => { operations.push(params[3]); return params[3] === 'check-point' ? { checked: true } : { x: 10, y: 20 }; };
  await h.browser.run('page_click', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {}, {});
  assert.deepEqual(operations, ['check-point', 'point', 'measure-point', 'measure-point']);
  assert.deepEqual(h.calls.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});
test('failed commands expose only the fixed method name, never the raw Chrome error or input value', async () => {
  const h = adapter(async () => { throw new Error('Secret https://site.test/?token=private typed=personal-data'); });
  const error = await h.browser.cdp(7, 'DOM.getNodeForLocation', { x: 1, y: 2 }, Date.now() + 1000).catch(error => error);
  assert.equal(error.code, 'BROWSER_COMMAND_FAILED'); assert.deepEqual(error.details, { command: 'DOM.getNodeForLocation' });
  assert.ok(!JSON.stringify(error).includes('private')); assert.ok(!error.message.includes('personal-data'));
});
test('stalled Chrome command returns a deadline error and is sent once', async () => {
  const h = adapter(async () => new Promise(() => {}));
  await assert.rejects(h.browser.cdp(7, 'Page.getFrameTree', {}, Date.now() + 25), { code: 'TIMEOUT' });
  assert.equal(h.calls.length, 1);
});
test('only a pure preflight failure is known not to have dispatched fill preparation', async () => {
  for (const [stage, failure, dispatched] of [['check-fill', 'ELEMENT_HIDDEN', false], ['check-fill', 'TIMEOUT', false], ['fill', 'ELEMENT_OBSCURED', true], ['fill', 'TIMEOUT', true]]) {
    const h = adapter();
    h.browser.evaluate = async (id, fn, params) => { if (params[3] === stage) throw new ControlError(failure, 'x'); return {}; };
    const progress = { dispatched: false };
    await assert.rejects(h.browser.run('page_fill', { tab_id: 7, value: 'v' }, 'https://example.test', Date.now() + 1000, async () => {}, progress), { code: failure });
    assert.equal(progress.dispatched, dispatched);
  }
});
test('screenshot is a CSS-pixel JPEG of the visual viewport', async () => {
  const h = adapter(async method => method === 'Page.captureScreenshot' ? { data: 'abc' } : {});
  h.browser.evaluate = async () => ({ x: 0, y: 300, width: 1280, height: 800, dpr: 2 });
  const result = await h.browser.run('page_screenshot', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {});
  assert.equal(result.mime_type, 'image/jpeg');
  assert.deepEqual(h.calls[0].params, { format: 'jpeg', quality: 70, captureBeyondViewport: false,
    clip: { x: 0, y: 300, width: 1280, height: 800, scale: 0.5 } });
  h.browser.evaluate = async () => { throw new ControlError('PAGE_EVALUATION_FAILED', 'x'); };
  await h.browser.run('page_screenshot', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {});
  assert.equal(h.calls[1].params.clip, undefined);
});
test('orphan cleanup detaches only attached tab targets and ignores refusals', async () => {
  const h = adapter(), detached = [];
  h.api.debugger.getTargets = async () => [{ attached: true, tabId: 3 }, { attached: false, tabId: 4 }, { attached: true, tabId: 5 }, { attached: true }];
  h.api.debugger.detach = async ({ tabId }) => { detached.push(tabId); if (tabId === 5) throw new Error('attached by DevTools'); };
  await h.browser.detachOrphans();
  assert.deepEqual(detached, [3, 5]);
});
test('scroll sends one trusted wheel event and reports the settled position', async () => {
  const h = adapter();
  let y = 0;
  h.browser.evaluate = async (id, fn) => {
    assert.equal(fn.name, 'scrollMetrics');
    return { container: 'page', x: 0, y, width: 1000, height: 3000, view_width: 1000, view_height: 800 };
  };
  h.api.debugger.sendCommand = async (target, method, params) => { h.calls.push({ method, params }); y = 640; return {}; };
  const result = await h.browser.run('page_scroll', { tab_id: 7, direction: 'down' }, 'https://example.test', Date.now() + 3000, async () => {});
  assert.deepEqual(h.calls.map(c => c.params), [{ type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 640 }]);
  assert.equal(result.moved, true); assert.equal(result.scroll_y, 640); assert.equal(result.reached_end, false);
});
test('scroll up by a set amount reports the top as the end', async () => {
  const h = adapter();
  h.browser.evaluate = async () => ({ container: 'element', x: 0, y: 0, width: 300, height: 900, view_width: 300, view_height: 300 });
  const result = await h.browser.run('page_scroll', { tab_id: 7, direction: 'up', amount: 50 }, 'https://example.test', Date.now() + 3000, async () => {});
  assert.equal(h.calls[0].params.deltaY, -50);
  assert.equal(result.moved, false); assert.equal(result.reached_end, true);
});
test('key press sends keyDown with text, then keyUp, and reports the focused target', async () => {
  const h = adapter();
  h.browser.evaluate = async (id, fn) => fn.name === 'focusedElement' ? { tag: 'input', label: '搜索', ref: 'e4', frame: false, password: false } : {};
  const progress = { dispatched: false };
  const result = await h.browser.run('page_press_key', { tab_id: 7, key: 'Enter' }, 'https://example.test', Date.now() + 1000, async () => {}, progress);
  assert.deepEqual(h.calls.map(c => [c.params.type, c.params.key, c.params.text]), [['keyDown', 'Enter', '\r'], ['keyUp', 'Enter', undefined]]);
  assert.equal(progress.dispatched, true);
  assert.equal(result.details.target.ref, 'e4');
  h.calls.length = 0;
  await h.browser.run('page_press_key', { tab_id: 7, key: 'Shift+Tab' }, 'https://example.test', Date.now() + 1000, async () => {}, {});
  assert.deepEqual(h.calls.map(c => [c.params.type, c.params.modifiers]), [['rawKeyDown', 8], ['keyUp', 8]]);
});
test('keys are refused before dispatch for frames, passwords and unfocusable refs', async () => {
  for (const [key, focused, code] of [['k', { frame: true }, 'FOCUS_IN_FRAME'], ['a', { password: true }, 'UNSUPPORTED_INPUT'], ['Enter', 'throw', 'NOT_FOCUSABLE']]) {
    const h = adapter();
    h.browser.evaluate = async (id, fn) => {
      if (focused === 'throw') throw new ControlError('NOT_FOCUSABLE', 'x');
      return fn.name === 'focusedElement' ? focused : {};
    };
    const progress = { dispatched: false };
    const args = { tab_id: 7, key, ...(focused === 'throw' ? { snapshot_id: 's', ref: 'e1' } : {}) };
    await assert.rejects(h.browser.run('page_press_key', args, 'https://example.test', Date.now() + 1000, async () => {}, progress), { code });
    assert.equal(h.calls.length, 0); assert.equal(progress.dispatched, false);
  }
  const h = adapter();
  h.browser.evaluate = async () => ({ password: true });
  await assert.rejects(h.browser.run('page_press_key', { tab_id: 7, key: 'Enter' }, 'https://example.test', Date.now() + 1000, async () => {}, {}), { code: 'UNSUPPORTED_INPUT' });
  assert.equal(h.calls.length, 0);
});
test('keys without ref are refused while a media player has focus; a ref targets it explicitly', async () => {
  const h = adapter();
  h.browser.evaluate = async (id, fn) => fn.name === 'focusedElement' ? { tag: 'div', label: 'Video player', media: true, frame: false, password: false } : {};
  const progress = { dispatched: false };
  await assert.rejects(h.browser.run('page_press_key', { tab_id: 7, key: 'End' }, 'https://example.test', Date.now() + 1000, async () => {}, progress), { code: 'FOCUS_ON_MEDIA' });
  assert.equal(h.calls.length, 0); assert.equal(progress.dispatched, false);
  await h.browser.run('page_press_key', { tab_id: 7, key: 'k', snapshot_id: 's', ref: 'e3' }, 'https://example.test', Date.now() + 1000, async () => {}, {});
  assert.equal(h.calls.length, 2);
});
test('snapshot reports the current keyboard focus', async () => {
  const h = adapter();
  h.browser.evaluate = async (id, fn) => fn.name === 'focusedElement' ? { tag: 'div', label: 'Video player', media: true } : { snapshot_id: 's1', elements: [] };
  const result = await h.browser.run('page_snapshot', { tab_id: 7 }, 'https://example.test', Date.now() + 1000, async () => {}, {});
  assert.equal(result.snapshot_id, 's1'); assert.equal(result.focused.media, true);
});
