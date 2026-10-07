import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameRouter } from '../extension/frames.mjs';
import { createPolicy } from '../extension/policy.mjs';
const origin = 'https://example.test';
function harness() {
  const read = [], commands = [];
  const main = { frame: { id: 'main', url: origin + '/', securityOrigin: origin }, childFrames: [
    { frame: { id: 'same', parentId: 'main', url: origin + '/frame', securityOrigin: origin } },
    { frame: { id: 'other', parentId: 'main', url: 'https://other.test/frame', securityOrigin: 'https://other.test' } }
  ] };
  const adapter = { api: { debugger: {} }, async cdp(target, method, params) {
    commands.push({ target, method, params });
    if (method === 'Page.getFrameTree') return { frameTree: target?.sessionId ? { frame: main.childFrames[1].frame } : main };
    if (method === 'DOM.getNodeForLocation') return { frameId: 'same' };
    return {};
  }, async evaluate(target, fn, args) {
    if (fn.name === 'viewportMetrics') return { width: target?.frameId ? 100 : 1000, height: 800 };
    if (fn.name === 'focusedElement') return null;
    read.push({ target, origin: args[0] });
    return { snapshot_id: args[1], text: target?.frameId || 'main', elements: [{ ref: 'e1', label: 'Control' }] };
  }, forget() {} };
  const router = new FrameRouter(adapter); router.owner = async () => ({ visible: true, supported: true, x: 100, y: 50, width: 200, height: 800 });
  return { router, adapter, main, read, commands };
}
test('same-origin frames are read; unapproved cross-origin frames never reach DOM evaluation', async () => {
  const h = harness();
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, createPolicy(origin));
  assert.equal(h.read.length, 2); assert.ok(h.read.every(r => r.origin === origin));
  assert.equal(shot.elements.length, 2); assert.equal(shot.frames[1].supported, false);
});
test('approved cross-process frames use their child session, not the root transport', async () => {
  const h = harness(); h.router.sessions.set('7:child', { tabId: 7, sessionId: 'child' });
  const policy = createPolicy(origin, { mode: 'extended' });
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, policy);
  const reference = shot.elements.find(e => e.frame === 'f2');
  const route = h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: reference.ref }, policy, origin);
  assert.equal(route.target.sessionId, 'child'); assert.equal(route.localRef, 'e1');
  assert.equal(h.read.find(r => r.origin === 'https://other.test').target.sessionId, 'child');
});
test('stale frame references and changed frame permissions fail closed', async () => {
  const h = harness(), policy = createPolicy(origin, { mode: 'extended' });
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, policy), ref = shot.elements.find(e => e.frame === 'f2').ref;
  assert.throws(() => h.router.route({ tab_id: 7, snapshot_id: 'old', ref }, policy, origin), { code: 'STALE_SNAPSHOT' });
  assert.throws(() => h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref }, createPolicy(origin), origin), { code: 'FRAME_ORIGIN_NOT_AUTHORIZED' });
  assert.throws(() => h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref }, createPolicy(origin, { mode: 'extended', blocked_sites: ['other.test'] }), origin), { code: 'FRAME_ORIGIN_NOT_AUTHORIZED' });
  h.router.forget(7);
  assert.throws(() => h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref }, policy, origin), { code: 'STALE_SNAPSHOT' });
});
test('blacklisted frame and its same-origin descendants never reach DOM evaluation', async () => {
  const h = harness();
  h.main.childFrames[1].childFrames = [{ frame: { id: 'descendant', parentId: 'other', url: origin + '/inside', securityOrigin: origin } }];
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, createPolicy(origin, { mode: 'extended', blocked_sites: ['other.test'] }));
  assert.deepEqual(h.read.map(r => r.target?.frameId || 'main'), ['main', 'same']);
  assert.equal(shot.frames.filter(f => !f.supported).length, 2);
});
test('hidden frame owners suppress the child DOM instead of exposing hidden content', async () => {
  const h = harness(); h.router.owner = async () => ({ visible: false });
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, createPolicy(origin));
  assert.equal(h.read.length, 1); assert.equal(shot.frames[0].reason, 'FRAME_HIDDEN');
});
test('frame point mapping includes parent offsets and scale, then checks the actual hit frame', async () => {
  const h = harness(), policy = createPolicy(origin);
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, policy);
  const route = h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: 'f1_e1' }, policy, origin);
  assert.deepEqual(await h.router.point(route, { x: 25, y: 30 }, Date.now() + 1000, async () => {}), { x: 150, y: 80 });
  h.adapter.cdp = async () => ({ frameId: 'main' });
  await assert.rejects(h.router.point(route, { x: 25, y: 30 }, Date.now() + 1000, async () => {}), { code: 'ELEMENT_OBSCURED' });
});
test('a scrolled root hit-tests document coordinates while returning viewport coordinates for input', async () => {
  const h = harness(), policy = createPolicy(origin);
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, policy);
  const route = h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: 'f1_e1' }, policy, origin);
  h.adapter.evaluate = async target => target?.frameId ? { width: 100, height: 800 } : { x: 35, y: 620, width: 1000, height: 800 };
  assert.deepEqual(await h.router.point(route, { x: 25, y: 30 }, Date.now() + 1000, async () => {}), { x: 150, y: 80 });
  const hit = h.commands.findLast(c => c.method === 'DOM.getNodeForLocation');
  assert.deepEqual(hit.params, { x: 185, y: 700, includeUserAgentShadowDOM: true });
});
test('root hit testing of an OOP iframe requires the exact host backend node and parent frame', async () => {
  const h = harness(), policy = createPolicy(origin, { mode: 'extended' });
  h.router.sessions.set('7:child', { tabId: 7, sessionId: 'child' });
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, policy);
  const route = h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: 'f2_e1' }, policy, origin);
  h.router.owner = async () => ({ visible: true, supported: true, x: 100, y: 50, width: 200, height: 800, backend_node_id: 42 });
  h.adapter.cdp = async () => ({ frameId: 'main', backendNodeId: 42 });
  assert.deepEqual(await h.router.point(route, { x: 25, y: 30 }, Date.now() + 1000, async () => {}), { x: 150, y: 80 });
  h.adapter.cdp = async () => ({ frameId: 'main', backendNodeId: 99 });
  await assert.rejects(h.router.point(route, { x: 25, y: 30 }, Date.now() + 1000, async () => {}), { code: 'ELEMENT_OBSCURED' });
  h.adapter.cdp = async () => ({ frameId: 'wrong-parent', backendNodeId: 42 });
  await assert.rejects(h.router.point(route, { x: 25, y: 30 }, Date.now() + 1000, async () => {}), { code: 'ELEMENT_OBSCURED' });
});
test('a frame whose ancestor is not approved remains blocked even if its own origin is approved', async () => {
  const h = harness(); h.main.childFrames[1].childFrames = [{ frame: { id: 'grandchild', parentId: 'other', url: origin + '/deep', securityOrigin: origin } }];
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, createPolicy(origin));
  assert.equal(shot.frames.find(f => f.frame_id === 'f3').supported, false); assert.equal(h.read.length, 2);
});
test('frame typing requires the logical focus chain, even when the child retains stale activeElement', async () => {
  const h = harness(), policy = createPolicy(origin);
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, policy);
  const route = h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: 'f1_e1' }, policy, origin);
  h.router.owner = async () => ({ visible: true, focused: true });
  await h.router.focus(route, Date.now() + 1000, async () => {});
  h.router.owner = async () => ({ visible: true, focused: false });
  await assert.rejects(h.router.focus(route, Date.now() + 1000, async () => {}), { code: 'FOCUS_CHANGED' });
});
test('root refs also expire after a scope/worker reset instead of reusing the isolated-world cache', async () => {
  const h = harness(); h.router.enabled.add(7);
  const shot = await h.router.snapshot(7, origin, Date.now() + 1000, async () => {}, createPolicy(origin));
  assert.equal(h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: 'e1' }, createPolicy(origin), origin), null);
  h.router.forget(7);
  assert.throws(() => h.router.route({ tab_id: 7, snapshot_id: shot.snapshot_id, ref: 'e1' }, createPolicy(origin), origin), { code: 'STALE_SNAPSHOT' });
});
