import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Controller } from '../extension/controller.mjs';
import { createPolicy } from '../extension/policy.mjs';
import { HOST_NAME, METHODS, VERSION, WIRE_VERSION, errorObject, webOrigin } from '../extension/protocol.mjs';

const script = (await fs.readFile(new URL('../extension/service-worker.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
function worker(initial = {}) {
  const data = structuredClone(initial), listeners = [], events = { addListener() {} };
  const tab = { id: 7, title: 'Synthetic preference test', url: 'https://example.test/' };
  const chrome = {
    storage: { local: { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, structuredClone(value)); } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    alarms: { onAlarm: events, async create() {}, async clear() {} },
    tabs: { onRemoved: events, onUpdated: events, async query() { return [tab]; } },
    debugger: { onDetach: events },
    runtime: { id: 'test-extension', getURL: file => 'chrome-extension://test-extension/' + file,
      connectNative() { return { onMessage: events, onDisconnect: events, postMessage() {} }; },
      onStartup: events, onInstalled: events, onMessage: { addListener(fn) { listeners.push(fn); } } }
  };
  class Adapter {
    async tab() { return { ...tab }; }
    async attach() {}
    async detach() {}
    async detachOrphans() {}
    forget() {}
  }
  vm.runInNewContext(script, { chrome, Controller, BrowserAdapter: Adapter, createPolicy, HOST_NAME, METHODS, VERSION, WIRE_VERSION, errorObject, webOrigin, URL, clearTimeout, setTimeout });
  const send = message => new Promise(resolve => {
    assert.equal(listeners[0](message, { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }, value => resolve(structuredClone(value))), true);
  });
  return { data, send, tab };
}
test('successful popup authorization saves canonical exclusions and lower modes retain the preference', async () => {
  const w = worker();
  assert.deepEqual(await w.send({ type: 'popup-grant', options: { mode: 'extended', blocked_sites: ['https://OTHER.test:8000/path'], minutes: 60 } }), { ok: true });
  assert.deepEqual(w.data.controlPreferences, { mode: 'extended', blocked_sites: ['other.test'], minutes: 60 });
  const state = await w.send({ type: 'popup-status' });
  assert.equal(state.grants.length, 1); assert.equal(state.grants[0].scope_kind, 'all_websites_except_blocked');
  assert.deepEqual(state.preferences.blocked_sites, ['other.test']);
  await w.send({ type: 'popup-apply', options: { mode: 'readonly', blocked_sites: [], minutes: 15 } });
  assert.deepEqual(w.data.controlPreferences, { mode: 'readonly', minutes: 15, blocked_sites: ['other.test'] });
});
test('saved preferences survive a worker restart but grants do not', async () => {
  const w = worker({ controlPreferences: { mode: 'extended', minutes: 30, blocked_sites: ['other.test'] } });
  const state = await w.send({ type: 'popup-status' });
  assert.equal(state.grants.length, 0); assert.equal(state.pending_tab_ids.length, 0);
  assert.equal(state.preferences.mode, 'extended'); assert.deepEqual(state.preferences.blocked_sites, ['other.test']);
});
test('a rejected blocked-site authorization does not overwrite the remembered settings', async () => {
  const w = worker({ controlPreferences: { mode: 'standard', minutes: 30, blocked_sites: [] } });
  const result = await w.send({ type: 'popup-grant', options: { mode: 'extended', blocked_sites: ['example.test'] } });
  assert.equal(result.error.code, 'SITE_BLOCKED');
  assert.deepEqual(w.data.controlPreferences, { mode: 'standard', minutes: 30, blocked_sites: [] });
  assert.equal((await w.send({ type: 'popup-status' })).grants.length, 0);
});
test('applying an exclusion for the current website stops control and remembers the blacklist', async () => {
  const w = worker();
  await w.send({ type: 'popup-grant', options: { mode: 'extended' } });
  const result = await w.send({ type: 'popup-apply', options: { mode: 'extended', blocked_sites: ['https://EXAMPLE.test/account'] } });
  assert.equal(result.ok, true);
  const state = await w.send({ type: 'popup-status' });
  assert.equal(state.grants.length, 0); assert.deepEqual(state.preferences.blocked_sites, ['example.test']);
  assert.equal((await w.send({ type: 'popup-grant', options: { mode: 'extended', blocked_sites: state.preferences.blocked_sites } })).error.code, 'SITE_BLOCKED');
});
