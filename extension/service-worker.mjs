import { Controller } from './controller.mjs';
import { BrowserAdapter } from './browser-adapter.mjs';
import { createPolicy } from './policy.mjs';
import { HOST_NAME, METHODS, VERSION, WIRE_VERSION, errorObject, webOrigin } from './protocol.mjs';
const adapter = new BrowserAdapter(chrome);
const controller = new Controller(adapter, {
  async loadLedger() { return (await chrome.storage.local.get('actionLedger')).actionLedger || {}; },
  async saveLedger(value) { await chrome.storage.local.set({ actionLedger: value }); }
});
let port = null, connected = false, sessionId = null, lastError = '', reconnectTimer = null, retryCount = 0;
let commandQueue = Promise.resolve();
async function badge() {
  await chrome.action.setBadgeText({ text: connected && controller.grants.size ? String(controller.grants.size) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#007C74' });
}
function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  lastError = '';
  try {
    const currentPort = chrome.runtime.connectNative(HOST_NAME);
    port = currentPort;
    currentPort.onMessage.addListener(message => {
      if (message?.v !== WIRE_VERSION || currentPort !== port) return;
      if (message.type === 'welcome') {
        connected = true; sessionId = message.session_id; retryCount = 0; lastError = '';
        void chrome.alarms.clear('bridge-reconnect'); void badge();
      } else if (message.type === 'ping') {
        currentPort.postMessage({ v: WIRE_VERSION, type: 'pong' });
      } else if (message.type === 'command') {
        if (typeof message.id !== 'string' || !Number.isFinite(message.deadline) || message.deadline > Date.now() + 15_000) return;
        // Serialize across clients and tabs so persistent write records stay ordered.
        commandQueue = commandQueue.catch(() => {}).then(async () => {
          let reply;
          try { reply = { result: await controller.execute(message.method, message.args, message.deadline) }; }
          catch (error) { reply = { error: errorObject(error) }; }
          if (port === currentPort) {
            try { currentPort.postMessage({ v: WIRE_VERSION, type: 'response', id: message.id, ...reply }); } catch {}
          }
        });
      }
    });
    currentPort.onDisconnect.addListener(() => {
      const raw = chrome.runtime.lastError?.message || '';
      if (port !== currentPort) return;
      port = null; connected = false; sessionId = null;
      const missing = /not found|not registered/i.test(raw);
      const reason = missing ? 'Chrome 未找到已登记主机（HOST_NOT_FOUND）。' :
        /forbidden|access.*denied/i.test(raw) ? 'Chrome 禁止访问本机主机（HOST_FORBIDDEN）。' :
        /failed to start/i.test(raw) ? 'Chrome 无法启动本机主机（HOST_START_FAILED）。' :
        /host has exited/i.test(raw) ? '本机主机启动后退出（HOST_EXITED）。' :
        /communicat/i.test(raw) ? '本机消息协议错误（HOST_PROTOCOL_ERROR）。' : '本机连接断开（HOST_DISCONNECTED）。';
      lastError = reason + (missing ? ' 请检查安装后重新连接。' : ' 正在等待重连。');
      console.error('Local Chrome Control: ' + reason);
      void badge();
      if (!missing) {
        retryCount++;
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(retryCount, 5), 30_000));
        void chrome.alarms.create('bridge-reconnect', { delayInMinutes: 0.5 });
      }
    });
    // The method list lets the host tell a stale extension copy apart from a bad request.
    currentPort.postMessage({ v: WIRE_VERSION, type: 'hello', origin: chrome.runtime.getURL(''), version: VERSION, methods: [...METHODS] });
  } catch {
    port = null; connected = false; lastError = '无法启动本地连接程序，请检查安装。';
    void badge();
  }
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-reconnect') connect(); if (alarm.name === 'scope-expiry') void controller.list().then(badge); });
void chrome.alarms.create('scope-expiry', { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { connect(); void badge(); });
chrome.tabs.onRemoved.addListener(id => { void controller.revoke(id, 'TAB_CLOSED').then(badge); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) void controller.onNavigation(id, change.url).then(badge);
  else if (change.status === 'loading') adapter.forget(id);
});
chrome.debugger.onDetach.addListener(source => {
  if (source.sessionId) return;
  // Chrome's Stop debugging button and DevTools revoke grants; never auto-reattach.
  void controller.revoke(source.tabId, 'DEBUGGER_DETACHED').then(badge);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  void (async () => {
    await controller.ready;
    if (message.type === 'popup-status') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let allowed = false;
      try { allowed = Boolean(tab && webOrigin(tab.url)); } catch {}
      const preferences = (await chrome.storage.local.get('controlPreferences')).controlPreferences || {};
      return { connected, session_id: sessionId, connection_error: lastError, version: VERSION, preferences,
        current: tab ? { id: tab.id, title: tab.title || '', url: allowed ? new URL(tab.url).origin : '', allowed } : null,
        grants: await controller.list(), pending_tab_ids: [...new Set([...controller.pendingGrants.keys(), ...controller.reconfiguring])], recent: controller.recent.slice(0, 5) };
    }
    if (message.type === 'popup-grant' || message.type === 'popup-apply') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');
      const selected = createPolicy(webOrigin(tab.url), message.options);
      if (message.type === 'popup-apply') await controller.reconfigure(tab, message.options);
      else await controller.grant(tab, message.options);
      const applied = controller.grants.get(tab.id)?.policy || selected;
      const previous = (await chrome.storage.local.get('controlPreferences')).controlPreferences || {};
      await chrome.storage.local.set({ controlPreferences: { mode: applied.mode, minutes: applied.minutes,
        blocked_sites: applied.mode === 'extended' ? applied.blocked_sites : previous.blocked_sites || [] } });
      await badge(); return { ok: true };
    }
    if (message.type === 'popup-revoke') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await controller.revoke(tab.id);
      await badge(); return { ok: true };
    }
    if (message.type === 'popup-stop-all') { await controller.revokeAll(); await badge(); return { ok: true }; }
    if (message.type === 'popup-reconnect') {
      if (port) { const previous = port; port = null; previous.disconnect(); }
      connected = false; connect(); return { ok: true };
    }
    return { error: { code: 'UNKNOWN_UI_ACTION', message: '不支持的操作。' } };
  })().then(sendResponse).catch(error => sendResponse({ error: errorObject(error) }));
  return true;
});
connect();
