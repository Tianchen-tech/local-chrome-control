import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../extension/controller.mjs';
import { createPolicy, permitsOrigin, normalizeBlockedSites } from '../extension/policy.mjs';
import { MUTATIONS } from '../extension/protocol.mjs';
const origin = 'https://example.test';
function harness() {
  let now = Date.now(), calls = 0, ledger = {};
  const tab = { id: 7, url: origin + '/', title: 'Synthetic' };
  const adapter = { async tab() { return { ...tab }; }, async attach() {}, async detach() {}, forget() {},
    async run() { calls++; return {}; } };
  const c = new Controller(adapter, { async loadLedger() { return ledger; }, async saveLedger(value) { ledger = structuredClone(value); } }, () => now);
  return { c, tab, adapter, get calls() { return calls; }, advance(ms) { now += ms; } };
}
async function claim(h, options = {}) {
  await h.c.grant(h.tab, options);
  const lease = await h.c.execute('tab_claim', { tab_id: 7, task_name: 'Modes' });
  return { tab_id: 7, lease_id: lease.lease_id, snapshot_id: 's1', ref: 'e1', request_id: 'modes-write-001' };
}
test('invalid exclusions and old allowlist settings cannot silently grant broad access', () => {
  for (const value of ['*.example.test', 'example.test/path', 'https://a:b@example.test', 'file:///tmp/test', 'ftp://example.test', 'bad host', 'https://bad\\host', '', '-bad.test']) {
    assert.throws(() => createPolicy(origin, { mode: 'extended', blocked_sites: [value] }));
  }
  assert.throws(() => createPolicy(origin, { mode: 'extended', origins: ['https://other.test'] }));
  assert.throws(() => createPolicy(origin, { mode: 'extended', frame_origins: [] }));
  assert.throws(() => createPolicy(origin, { mode: 'extended', blocked_sites: null }));
  assert.throws(() => createPolicy(origin, { mode: 'extended', blocked_sites: Array(201).fill('other.test') }));
  assert.throws(() => createPolicy(origin, { mode: 'god' }));
  assert.throws(() => createPolicy(origin, { mode: 'standard', blocked_sites: ['other.test'] }));
  assert.throws(() => createPolicy(origin, { execute_javascript: true }));
  assert.equal(permitsOrigin(createPolicy(origin), 'https://sub.example.test'), false);
  assert.equal(permitsOrigin({ mode: 'extended', origins: [origin], frame_origins: [] }, origin), false);
});
test('URL paste exclusions normalize domains and block subdomains, protocols, ports and trailing dots', () => {
  assert.deepEqual(normalizeBlockedSites(['https://OTHER.test:8443/path?q=x#x', 'other.test.', 'localhost:19321', '[::1]', 'https://例子.测试/path']),
    ['other.test', 'localhost', '[::1]', 'xn--fsqu00a.xn--0zwm56d']);
  const policy = createPolicy(origin, { mode: 'extended', blocked_sites: ['other.test', 'localhost', '[::1]', '127.0.0.1', '例子.测试'] });
  for (const url of ['https://other.test', 'http://login.other.test:8000', 'https://other.test.', 'http://localhost:19320', 'http://[::1]:19320', 'http://127.0.0.1:80', 'https://例子.测试']) {
    assert.equal(permitsOrigin(policy, url), false, url);
    assert.equal(permitsOrigin(policy, url, true, url), false, 'same-origin frames cannot bypass exclusions');
  }
  for (const url of ['https://other.test.evil.test', 'https://evil-other.test', 'http://127.0.0.2', origin]) assert.equal(permitsOrigin(policy, url), true, url);
});
test('the highest tier still refuses privileged schemes, credential URLs and the extension store', () => {
  const policy = createPolicy(origin, { mode: 'extended' });
  for (const url of ['chrome://settings', 'file:///tmp/test', 'data:text/html,test', 'javascript:alert(1)', 'https://a:b@other.test', 'https://chromewebstore.google.com', 'https://chrome.google.com/webstore/detail/test']) {
    assert.equal(permitsOrigin(policy, url), false, url);
    assert.equal(permitsOrigin(policy, url, true, origin), false, url);
  }
});
test('a blocked current tab is rejected before Chrome debugger attachment', async () => {
  const h = harness(); let attached = 0;
  h.adapter.attach = async () => { attached++; };
  await assert.rejects(h.c.grant(h.tab, { mode: 'extended', blocked_sites: ['example.test'] }), { code: 'SITE_BLOCKED' });
  assert.equal(attached, 0); assert.equal(h.c.grants.size, 0);
});
test('readonly blocks every write and scrolling at the controller, while snapshot and screenshot work', async () => {
  const h = harness(), args = await claim(h, { mode: 'readonly' });
  for (const method of [...MUTATIONS, 'page_scroll']) {
    const value = { ...args, value: 'hello', key: 'Enter', direction: 'down', url: origin + '/next' };
    await assert.rejects(h.c.execute(method, value), { code: 'READ_ONLY_MODE' });
  }
  assert.equal(h.calls, 0);
  await h.c.execute('page_snapshot', args); await h.c.execute('page_screenshot', args);
  assert.equal(h.calls, 2);
});
test('extended navigation needs no allowed URLs and retains the lease until a blocked destination', async () => {
  const h = harness(), args = await claim(h, { mode: 'extended', blocked_sites: ['blocked.test'] }); let dispatched = 0;
  h.adapter.run = async (method, args, origin, deadline, guard, progress) => {
    dispatched++; progress.dispatched = true; h.tab.url = args.url; await h.c.onNavigation(7, args.url); return {};
  };
  await h.c.execute('page_navigate', { ...args, url: 'https://other.test/next' });
  assert.equal(h.c.grants.get(7).origin, 'https://other.test');
  assert.equal(h.c.grants.get(7).lease.id, args.lease_id);
  await h.c.execute('page_navigate', { ...args, request_id: 'modes-write-002', url: 'https://new.test/' });
  assert.equal(h.c.grants.get(7).lease.id, args.lease_id);
  await assert.rejects(h.c.execute('page_navigate', { ...args, request_id: 'modes-write-003', url: 'https://sub.blocked.test/' }), { code: 'SITE_BLOCKED' });
  assert.equal(dispatched, 2); assert.equal(h.tab.url, 'https://new.test/');
  const tab = (await h.c.list())[0]; assert.equal(tab.scope_kind, 'all_websites_except_blocked'); assert.deepEqual(tab.blocked_sites, ['blocked.test']);
});
test('a redirect onto the blacklist revokes authorization and marks dispatched navigation unknown', async () => {
  const h = harness(), args = await claim(h, { mode: 'extended', blocked_sites: ['unknown.test'] });
  h.adapter.run = async (method, args, origin, deadline, guard, progress) => { progress.dispatched = true; h.tab.url = 'https://unknown.test/'; return {}; };
  await assert.rejects(h.c.execute('page_navigate', { ...args, url: 'https://other.test/' }), { code: 'ACTION_STATUS_UNKNOWN' });
  assert.equal(h.c.grants.size, 0);
  assert.equal((await h.c.execute('request_status', { request_id: args.request_id })).status, 'unknown');
});
test('a read racing an allowed-origin transition is suppressed and requires a new snapshot', async () => {
  const h = harness(), args = await claim(h, { mode: 'extended' });
  h.adapter.run = async () => { h.tab.url = 'https://other.test/'; return { text: 'stale output' }; };
  await assert.rejects(h.c.execute('page_snapshot', args), { code: 'CONTEXT_LOST' });
});
test('authorization expiry is fixed and cannot be extended by activity or new claims', async () => {
  const h = harness(), args = await claim(h, { minutes: 1 });
  const until = h.c.grants.get(7).policy.expires_at;
  h.advance(30_000); await h.c.execute('page_snapshot', args);
  assert.equal(h.c.grants.get(7).policy.expires_at, until);
  h.advance(30_001);
  await assert.rejects(h.c.execute('page_snapshot', args), { code: 'AUTHORIZATION_EXPIRED' });
  assert.equal(h.c.grants.size, 0);
});
test('downgrading invalidates the previous lease; a new readonly lease cannot write', async () => {
  const h = harness(), args = await claim(h);
  await h.c.reconfigure(h.tab, { mode: 'readonly' });
  await assert.rejects(h.c.execute('page_click', args), { code: 'LEASE_EXPIRED' });
  const lease = await h.c.execute('tab_claim', { tab_id: 7, task_name: 'Read only' });
  await assert.rejects(h.c.execute('page_click', { ...args, lease_id: lease.lease_id }), { code: 'READ_ONLY_MODE' });
});
test('Stop during reconfiguration cannot be undone by a late reattachment', async () => {
  const h = harness(); await claim(h); let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  h.adapter.tab = async () => { began(); await new Promise(resolve => { finish = resolve; }); return { ...h.tab }; };
  const applying = h.c.reconfigure(h.tab, { mode: 'extended' });
  await started; await h.c.revokeAll(); finish();
  await assert.rejects(applying, { code: 'AUTHORIZATION_CHANGED' });
  assert.equal(h.c.grants.size, 0);
});
test('extended frames use the same exclusions; lower modes retain same-origin scope', () => {
  const policy = createPolicy(origin, { mode: 'extended', blocked_sites: ['other.test'] });
  assert.equal(permitsOrigin(policy, 'https://other.test', true, origin), false);
  assert.equal(permitsOrigin(policy, 'https://embed.test', true, origin), true);
  assert.equal(permitsOrigin(policy, 'https://embed.test'), true);
  assert.equal(permitsOrigin(policy, origin, true, origin), true);
  for (const mode of ['readonly', 'standard']) assert.equal(permitsOrigin(createPolicy(origin, { mode }), 'https://embed.test', true, origin), false);
});
test('manual navigation to an excluded page stops control before further page reads', async () => {
  const h = harness(), args = await claim(h, { mode: 'extended', blocked_sites: ['blocked.test'] });
  h.tab.url = 'https://blocked.test/'; await h.c.onNavigation(7, h.tab.url);
  await assert.rejects(h.c.execute('page_snapshot', args), { code: 'TAB_NOT_AUTHORIZED' });
  assert.equal(h.calls, 0); assert.equal(h.c.grants.size, 0);
});
test('changing exclusions invalidates old leases and cached references', async () => {
  const h = harness(), args = await claim(h, { mode: 'extended' }); let forgotten = 0;
  h.adapter.forget = () => { forgotten++; };
  await h.c.reconfigure(h.tab, { mode: 'extended', blocked_sites: ['other.test'] });
  await assert.rejects(h.c.execute('page_click', args), { code: 'LEASE_EXPIRED' });
  const lease = await h.c.execute('tab_claim', { tab_id: 7, task_name: 'Updated exclusions' });
  await assert.rejects(h.c.execute('page_navigate', { ...args, lease_id: lease.lease_id, url: 'https://other.test' }), { code: 'SITE_BLOCKED' });
  assert.ok(forgotten); assert.equal(h.calls, 0);
});
test('excluding the current website through reconfiguration immediately revokes the existing lease', async () => {
  const h = harness(), args = await claim(h, { mode: 'extended' }); let detached = 0;
  h.adapter.detach = async () => { detached++; };
  await h.c.reconfigure(h.tab, { mode: 'extended', blocked_sites: ['example.test'] });
  assert.equal(h.c.grants.size, 0); assert.equal(detached, 1);
  await assert.rejects(h.c.execute('page_snapshot', args), { code: 'TAB_NOT_AUTHORIZED' });
  assert.equal(h.calls, 0);
});
