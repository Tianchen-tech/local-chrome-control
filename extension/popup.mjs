const el = id => document.getElementById(id);
const labels = { page_snapshot: '读取页面', page_click: '点击元素', page_fill: '填写表单', page_select: '选择选项', page_screenshot: '截取页面',
  page_type_text: '输入文本', page_navigate: '页面跳转', page_scroll: '滚动页面', page_press_key: '按键', tab_claim: '任务取得控制权', tab_release: '任务释放控制权', tabs_list: '查看授权标签页', status: '连接检查', request_status: '核对操作结果', stop: '停止控制' };
let busy = false, stopping = false, polling = false, dirty = false, currentId = null;
const modeNames = { readonly: '只读', standard: '标准', extended: '扩展' };
function modeView() {
  el('extended-fields').hidden = el('mode').value !== 'extended';
  el('mode-note').textContent = { readonly: '只读取和截图，不执行点击、输入、滚动或跳转。', standard: '当前网站可读写；支持富文本、开放 Shadow DOM 和同源框架。', extended: '在当前授权标签页跨站连续操作，跨源内嵌框架也可操作；黑名单除外。不必填写允许访问的网址。' }[el('mode').value];
}
function options() {
  const split = id => el(id).value.split(/\s+/).filter(Boolean);
  return { mode: el('mode').value, minutes: Number(el('minutes').value), blocked_sites: el('mode').value === 'extended' ? split('blocked-sites') : [] };
}
for (const id of ['mode', 'blocked-sites', 'minutes']) el(id).addEventListener('input', () => { dirty = true; modeView(); });
async function send(type, settings) {
  const response = await chrome.runtime.sendMessage({ type, ...(settings ? { options: settings } : {}) });
  if (response?.error) throw new Error(response.error.message);
  return response;
}
function showError(message) { el('error').textContent = message; el('error').hidden = !message; }
async function refresh() {
  if (polling) return; polling = true;
  try {
    const state = await send('popup-status');
    el('version').textContent = state.version;
    el('status').textContent = state.connected ? '本地连接已就绪' : '本地连接未就绪';
    el('dot').classList.toggle('online', state.connected);
    el('connection-note').textContent = state.connection_error || '控制消息通过本机连接传递，不经过代理。';
    el('session-id').textContent = state.session_id ? '连接 ID · ' + state.session_id : '';
    el('session-id').hidden = !state.connected || !state.session_id;
    el('tab-title').textContent = state.current?.title || '没有可控制的标签页';
    el('tab-origin').textContent = state.current?.url || '请打开普通网页后再授权';
    const grant = state.grants.find(g => g.tab_id === state.current?.id);
    if (currentId !== state.current?.id) { currentId = state.current?.id; dirty = false; }
    if (!dirty) {
      el('mode').value = grant?.mode || state.preferences?.mode || 'standard';
      el('minutes').value = String(grant?.authorization_minutes || state.preferences?.minutes || 30);
      el('blocked-sites').value = (grant?.mode === 'extended' ? grant.blocked_sites || [] : state.preferences?.blocked_sites || []).join('\n');
    }
    modeView();
    el('scope-summary').hidden = !grant;
    const scope = grant?.mode === 'extended' ? '所有普通网站' + (grant.blocked_sites?.length ? '，排除 ' + grant.blocked_sites.length + ' 个域名' : '，无黑名单') : (grant?.allowed_origins || []).join('、');
    el('scope-summary').textContent = grant?.mode ? modeNames[grant.mode] + ' · ' + scope + ' · 到期 ' + new Date(grant.authorization_expires_at).toLocaleTimeString() : '';
    el('apply').hidden = !grant; el('apply').disabled = busy || stopping || !state.connected;
    const pending = state.pending_tab_ids?.includes(state.current?.id);
    el('permission').textContent = pending ? '正在授权…' : grant ? (grant.controlled_by ? '控制中 · ' + grant.controlled_by : '已授权 · 等待任务连接') : '尚未授权';
    el('permission').classList.toggle('active', Boolean(grant));
    el('grant').hidden = Boolean(grant || pending); el('grant').disabled = busy || stopping || !state.connected || !state.current?.allowed;
    el('stop').hidden = !(grant || pending); el('stop').disabled = stopping;
    el('stop-all').disabled = stopping || (!state.grants.length && !state.pending_tab_ids?.length);
    el('count').textContent = state.grants.length + ' 个已授权';
    const list = el('events'); list.replaceChildren();
    if (!state.recent.length) { const item = document.createElement('li'); item.className = 'empty'; item.textContent = '尚无控制操作'; list.append(item); }
    for (const event of state.recent) {
      const item = document.createElement('li'); item.classList.toggle('failed', event.code !== 'OK');
      item.append(document.createTextNode((labels[event.method] || event.method) + (event.code === 'OK' ? '' : ' · ' + event.code)));
      const timing = document.createElement('span');
      timing.textContent = event.elapsed_ms < 1000 ? event.elapsed_ms + ' ms' : (event.elapsed_ms / 1000).toFixed(1) + ' s';
      item.append(timing); list.append(item);
    }
  } catch (error) { showError(error.message); } finally { polling = false; }
}
for (const [id, type] of [['grant', 'popup-grant'], ['apply', 'popup-apply'], ['stop', 'popup-revoke'], ['stop-all', 'popup-stop-all'], ['reconnect', 'popup-reconnect']]) {
  el(id).addEventListener('click', async () => {
    const isStop = type === 'popup-revoke' || type === 'popup-stop-all';
    if (isStop ? stopping : busy || stopping) return;
    if (isStop) stopping = true; else busy = true;
    el(id).disabled = true; showError('');
    try { await send(type, ['popup-grant', 'popup-apply'].includes(type) ? options() : undefined); dirty = false; } catch (error) { showError(error.message); }
    finally { if (isStop) stopping = false; else busy = false; el(id).disabled = false; await refresh(); }
  });
}
void refresh();
const timer = setInterval(() => void refresh(), 1500);
window.addEventListener('unload', () => clearInterval(timer));
