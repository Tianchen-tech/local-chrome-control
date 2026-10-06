const el = id => document.getElementById(id);
const labels = { page_snapshot: '读取页面', page_click: '点击元素', page_fill: '填写表单', page_select: '选择选项', page_screenshot: '截取页面',
  page_navigate: '页面跳转', page_scroll: '滚动页面', page_press_key: '按键', tab_claim: '任务取得控制权', tab_release: '任务释放控制权', tabs_list: '查看授权标签页', status: '连接检查', request_status: '核对操作结果', stop: '停止控制' };
let busy = false, stopping = false, polling = false;
async function send(type) {
  const response = await chrome.runtime.sendMessage({ type });
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
for (const [id, type] of [['grant', 'popup-grant'], ['stop', 'popup-revoke'], ['stop-all', 'popup-stop-all'], ['reconnect', 'popup-reconnect']]) {
  el(id).addEventListener('click', async () => {
    const isStop = type === 'popup-revoke' || type === 'popup-stop-all';
    if (isStop ? stopping : busy || stopping) return;
    if (isStop) stopping = true; else busy = true;
    el(id).disabled = true; showError('');
    try { await send(type); } catch (error) { showError(error.message); }
    finally { if (isStop) stopping = false; else busy = false; el(id).disabled = false; await refresh(); }
  });
}
void refresh();
const timer = setInterval(() => void refresh(), 1500);
window.addEventListener('unload', () => clearInterval(timer));
