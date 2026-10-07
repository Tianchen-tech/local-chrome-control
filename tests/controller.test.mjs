import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../extension/controller.mjs';
import { LEASE_MS, LEDGER_LIMIT, LEDGER_RETENTION_MS, ControlError } from '../extension/protocol.mjs';
function harness(saved = {}) {
  let persisted = structuredClone(saved), now = Date.now(), calls = 0;
  const tab = { id: 7, url: 'https://example.test/form', title: 'Form' };
  const adapter = {
    async tab() { return { ...tab }; }, async attach() {}, async detach() {}, forget() {},
    async run(method) { calls++; return method === 'page_snapshot' ? { snapshot_id: 'snap-1', elements: [] } : { ok: true }; }
  };
  const storage = { async loadLedger() { return structuredClone(persisted); }, async saveLedger(value) { persisted = structuredClone(value); } };
  const c = new Controller(adapter, storage, () => now);
  return { c, tab, adapter, storage, get calls() { return calls; }, get persisted() { return persisted; }, advance(ms) { now += ms; } };
}
async function claim(h) {
  await h.c.grant(h.tab);
  return h.c.execute('tab_claim', { tab_id: 7, task_name: 'Fixture' });
}
const action = lease => ({ tab_id: 7, lease_id: lease.lease_id, snapshot_id: 'snap-1', ref: 'e1', request_id: 'test-click-001' });
test('ungranted tabs are absent and cannot be claimed', async () => {
  const h = harness();
  assert.deepEqual((await h.c.execute('tabs_list')).tabs, []);
  await assert.rejects(h.c.execute('tab_claim', { tab_id: 7, task_name: 'x' }), { code: 'TAB_NOT_AUTHORIZED' });
});
test('one task owns a tab; releasing lets another task claim', async () => {
  const h = harness(), lease = await claim(h);
  await assert.rejects(h.c.execute('tab_claim', { tab_id: 7, task_name: 'Other task' }), { code: 'TAB_BUSY' });
  await h.c.execute('tab_release', { tab_id: 7, lease_id: lease.lease_id });
  assert.ok((await h.c.execute('tab_claim', { tab_id: 7, task_name: 'Other task' })).lease_id);
});
test('expired lease cannot read page', async () => {
  const h = harness(), lease = await claim(h);
  h.advance(LEASE_MS + 1);
  await assert.rejects(h.c.execute('page_snapshot', action(lease)), { code: 'LEASE_EXPIRED' });
  assert.equal(h.calls, 0);
});
test('duplicate successful write does not click twice; changed payload is rejected', async () => {
  const h = harness(), lease = await claim(h);
  for (const request_id of ['test-click-001', '__proto__', 'constructor']) {
    const args = { ...action(lease), request_id };
    assert.equal((await h.c.execute('page_click', args)).status, 'done');
    assert.equal((await h.c.execute('page_click', args)).replayed, true);
    await assert.rejects(h.c.execute('page_click', { ...args, ref: 'e2' }), { code: 'REQUEST_ID_CONFLICT' });
  }
  assert.equal(h.calls, 3);
});
test('pending request is durable before dispatch and records no form data', async () => {
  const h = harness(), lease = await claim(h);
  h.adapter.run = async () => { assert.equal(h.persisted['test-click-001'].status, 'pending'); return {}; };
  await h.c.execute('page_fill', { ...action(lease), value: 'private fixture content' });
  assert.ok(!JSON.stringify(h.persisted).includes('private fixture content'));
  assert.equal(h.persisted['test-click-001'].status, 'done');
});
test('lost write reply is unknown and is not repeated after controller restart', async () => {
  const h = harness(), lease = await claim(h), args = action(lease);
  let clicks = 0;
  h.adapter.run = async (method, args, origin, deadline, guard, progress) => {
    clicks++; progress.dispatched = true; throw new ControlError('BRIDGE_DISCONNECTED', 'lost reply');
  };
  await assert.rejects(h.c.execute('page_click', args), { code: 'ACTION_STATUS_UNKNOWN' });
  const restarted = new Controller(h.adapter, h.storage);
  await restarted.ready;
  assert.equal((await restarted.execute('request_status', { request_id: args.request_id })).status, 'unknown');
  await assert.rejects(restarted.execute('page_click', args), { code: 'ACTION_STATUS_UNKNOWN' });
  assert.equal(clicks, 1);
});
test('worker restart converts pending to unknown and clears tab grants', async () => {
  const h = harness({ interrupted: { status: 'pending', fingerprint: 'x', at: Date.now() } });
  await h.c.ready;
  assert.equal(h.persisted.interrupted.status, 'unknown');
  assert.equal(h.c.grants.size, 0);
});
test('user stop revokes control and does not automatically attach again', async () => {
  const h = harness(), lease = await claim(h);
  let attaches = 0; h.adapter.attach = async () => { attaches++; };
  await h.c.revoke(7);
  await assert.rejects(h.c.execute('page_snapshot', action(lease)), { code: 'TAB_NOT_AUTHORIZED' });
  assert.equal(attaches, 0);
});
test('cross-origin navigation revokes grant; explicit cross-origin request does not dispatch', async () => {
  const h = harness(), lease = await claim(h);
  await assert.rejects(h.c.execute('page_navigate', { ...action(lease), url: 'https://other.test/' }), { code: 'ORIGIN_NOT_AUTHORIZED' });
  assert.equal(h.calls, 0);
  h.tab.url = 'https://other.test/';
  await assert.rejects(h.c.execute('page_snapshot', action(lease)), { code: 'ORIGIN_CHANGED' });
  assert.equal(h.c.grants.size, 0);
});
test('navigation racing a read suppresses the returned content', async () => {
  const h = harness(), lease = await claim(h);
  h.adapter.run = async () => { h.tab.url = 'https://other.test/'; return { secret: 'must not return' }; };
  await assert.rejects(h.c.execute('page_snapshot', action(lease)), { code: 'ORIGIN_CHANGED' });
});
test('deadline that expired in queue never dispatches', async () => {
  const h = harness(), lease = await claim(h);
  await assert.rejects(h.c.execute('page_click', action(lease), Date.now() - 1), { code: 'TIMEOUT' });
  assert.equal(h.calls, 0);
});
test('ledger at capacity fails closed instead of evicting recent request IDs', async () => {
  const saved = Object.fromEntries(Array.from({ length: LEDGER_LIMIT }, (_, i) => ['request-' + i, { at: Date.now(), status: 'done' }]));
  const h = harness(saved), lease = await claim(h);
  await assert.rejects(h.c.execute('page_click', action(lease)), { code: 'LEDGER_FULL' });
  assert.equal(h.calls, 0);
});
test('metadata omits URL query and lease secrets', async () => {
  const h = harness(); h.tab.url += '?token=private'; const lease = await claim(h);
  const text = JSON.stringify(await h.c.execute('tabs_list'));
  assert.ok(!text.includes('private')); assert.ok(!text.includes(lease.lease_id));
});
test('stop during a slow attachment prevents a late grant from becoming active', async () => {
  const h = harness(); await h.c.ready;
  let finishAttach, started;
  const attaching = new Promise(resolve => { started = resolve; });
  h.adapter.attach = async () => { started(); await new Promise(resolve => { finishAttach = resolve; }); };
  const pending = h.c.grant(h.tab);
  await attaching;
  await h.c.revokeAll();
  finishAttach();
  await assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' });
  assert.equal(h.c.grants.size, 0);
  assert.equal(h.c.pendingGrants.size, 0);
});
test('stop while checking tab metadata prevents both reads and new leases', async () => {
  for (const operation of ['page_snapshot', 'tab_claim']) {
    const h = harness(), lease = await claim(h);
    if (operation === 'tab_claim') await h.c.execute('tab_release', { tab_id: 7, lease_id: lease.lease_id });
    h.adapter.tab = async () => { await h.c.revoke(7); return { ...h.tab }; };
    const args = operation === 'tab_claim' ? { tab_id: 7, task_name: 'late claim' } : action(lease);
    await assert.rejects(h.c.execute(operation, args), { code: 'TAB_NOT_AUTHORIZED' });
    assert.equal(h.calls, 0);
    assert.equal(h.c.grants.size, 0);
  }
});
test('cross-origin navigation during a pending attachment cancels authorization', async () => {
  const h = harness();
  h.adapter.attach = async () => { await h.c.onNavigation(7, 'https://other.test/'); };
  await assert.rejects(h.c.grant(h.tab), { code: 'AUTHORIZATION_CHANGED' });
  assert.equal(h.c.grants.size, 0);
});
test('another grant click cannot replace a live task lease', async () => {
  const h = harness(), lease = await claim(h);
  await h.c.grant(h.tab);
  assert.equal(h.c.grants.get(7).lease.id, lease.lease_id);
});
test('write rejected before dispatch reports its cause and may run again', async () => {
  const h = harness(), lease = await claim(h), args = action(lease);
  let clicks = 0;
  h.adapter.run = async () => { throw new ControlError('STALE_SNAPSHOT', 'stale'); };
  await assert.rejects(h.c.execute('page_click', args), error =>
    error.code === 'STALE_SNAPSHOT' && error.details.executed === false && error.details.request_id === args.request_id);
  assert.equal((await h.c.execute('request_status', { request_id: args.request_id })).status, 'failed');
  h.adapter.run = async () => { clicks++; return {}; };
  assert.equal((await h.c.execute('page_click', args)).status, 'done');
  assert.equal(clicks, 1);
});
test('write rejected by the lease check is reported as not executed', async () => {
  const h = harness(), lease = await claim(h);
  h.advance(LEASE_MS + 1);
  await assert.rejects(h.c.execute('page_click', action(lease)), error => error.code === 'LEASE_EXPIRED' && error.details.executed === false);
  await assert.rejects(h.c.execute('page_click', action(lease), Date.now() - 1), error => error.code === 'TIMEOUT' && error.details.executed === false);
  assert.equal(h.calls, 0);
});
test('old records are pruned unless their grant is still live', async () => {
  const old = Date.now() - LEDGER_RETENTION_MS - 1;
  const h = harness({ ended: { at: old, status: 'done', epoch: 'gone' } }), lease = await claim(h);
  h.c.ledger.live = { at: old, status: 'done', epoch: h.c.grants.get(7).epoch };
  await h.c.execute('page_click', action(lease));
  assert.equal(h.persisted.ended, undefined);
  assert.ok(h.persisted.live);
});
test('worker restart detaches debugger sessions left by lost grants', async () => {
  const h = harness(); await h.c.ready;
  let cleaned = 0;
  h.adapter.detachOrphans = async () => { cleaned++; };
  const restarted = new Controller(h.adapter, h.storage);
  await restarted.ready;
  assert.equal(cleaned, 1);
  h.adapter.detachOrphans = async () => { throw new Error('getTargets failed'); };
  await new Controller(h.adapter, h.storage).ready;
});
test('key press returns its target to the caller without persisting page text', async () => {
  const h = harness(), lease = await claim(h);
  h.adapter.run = async () => ({ details: { pressed: 'Enter', target: { tag: 'input', label: 'private label' } } });
  const result = await h.c.execute('page_press_key', { tab_id: 7, lease_id: lease.lease_id, key: 'Enter', request_id: 'press-enter-01' });
  assert.equal(result.status, 'done'); assert.equal(result.target.label, 'private label');
  assert.ok(!JSON.stringify(h.persisted).includes('private label'));
  assert.equal((await h.c.execute('page_press_key', { tab_id: 7, lease_id: lease.lease_id, key: 'Enter', request_id: 'press-enter-01' })).replayed, true);
  await assert.rejects(h.c.execute('page_press_key', { tab_id: 7, lease_id: lease.lease_id, key: 'Escape', request_id: 'press-enter-01' }), { code: 'REQUEST_ID_CONFLICT' });
});
test('scroll needs a lease but no request id and is not recorded', async () => {
  const h = harness(), lease = await claim(h);
  await h.c.execute('page_scroll', { tab_id: 7, lease_id: lease.lease_id, direction: 'down' });
  assert.deepEqual(h.persisted, {});
  await assert.rejects(h.c.execute('page_scroll', { tab_id: 7, lease_id: lease.lease_id, direction: 'sideways' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(h.c.execute('page_scroll', { tab_id: 7, lease_id: lease.lease_id, direction: 'down', ref: 'e1' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(h.c.execute('page_press_key', { tab_id: 7, lease_id: lease.lease_id, key: 'Control+v', request_id: 'press-paste-01' }), { code: 'INVALID_ARGUMENT' });
});
