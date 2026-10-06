import { Controller } from './controller.mjs';
import { BrowserAdapter } from './browser-adapter.mjs';
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
      lastError = missing ? '未安装本地连接程序。请按安装说明完成设置，然后重新连接。' : '本地连接已断开，正在等待重连。';
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
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-reconnect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { connect(); void badge(); });
chrome.tabs.onRemoved.addListener(id => { void controller.revoke(id, 'TAB_CLOSED').then(badge); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) void controller.onNavigation(id, change.url).then(badge);
  else if (change.status === 'loading') adapter.forget(id);
});
chrome.debugger.onDetach.addListener(source => {
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
      return { connected, session_id: sessionId, connection_error: lastError, version: VERSION,
        current: tab ? { id: tab.id, title: tab.title || '', url: allowed ? new URL(tab.url).origin : '', allowed } : null,
        grants: await controller.list(), pending_tab_ids: [...controller.pendingGrants.keys()], recent: controller.recent.slice(0, 5) };
    }
    if (message.type === 'popup-grant') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab');
      await controller.grant(tab); await badge(); return { ok: true };
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
