const el = id => document.getElementById(id);
const labels = { page_snapshot: '读取页面', page_click: '点击元素', page_fill: '填写表单', page_select: '选择选项', page_screenshot: '截取页面',
  page_type_text: '输入文本', page_navigate: '页面跳转', page_scroll: '滚动页面', page_press_key: '按键', tab_claim: '任务取得控制权', tab_release: '任务释放控制权', tabs_list: '查看授权标签页', status: '连接检查', request_status: '核对操作结果', stop: '停止控制' };
const icons = { page_snapshot: 'eye', page_screenshot: 'camera', page_click: 'cursor', page_fill: 'keyboard', page_type_text: 'keyboard', page_press_key: 'keyboard',
  page_select: 'list', page_scroll: 'scroll', page_navigate: 'arrow', tab_claim: 'key', tab_release: 'key', stop: 'stop' };
// Plain-language reasons for the failures users are most likely to see; the code stays in the tooltip.
const reasons = { FOCUS_ON_MEDIA: '焦点在播放器上，已拦截', UNVERIFIED_FOCUS: '无法确认键盘目标，已拦截', TAB_NOT_AUTHORIZED: '标签页未授权', LEASE_EXPIRED: '任务控制权已过期',
  STALE_SNAPSHOT: '页面已变化，需要重新读取', STALE_REF: '页面已变化，需要重新读取', ELEMENT_CHANGED: '元素已变化', ELEMENT_OBSCURED: '元素被遮挡', ELEMENT_HIDDEN: '元素不可见',
  TIMEOUT: '等待超时', ACTION_STATUS_UNKNOWN: '结果待确认，请检查页面', ORIGIN_NOT_AUTHORIZED: '超出授权网站', SITE_BLOCKED: '网站在黑名单中', ORIGIN_CHANGED: '页面已切换网站',
  EXTENSION_OUTDATED: '扩展版本过旧', DEBUGGER_DETACHED: '调试连接被关闭', TAB_CLOSED: '标签页已关闭', USER_STOPPED: '已手动停止' };
const modeNames = { readonly: '只读', standard: '标准', extended: '扩展' };
const modeNotes = { readonly: '只读限制插件动作；安装时取得的 Chrome 调试权限仍然存在。', standard: '', extended: '跨源内嵌框架也可操作。可以设置不允许访问的网站。' };
// Headline, detail and icon for each state of the current tab.
const views = {
  idle: ['尚未授权', '选择允许的范围，然后授权。', 'lock'],
  disconnected: ['尚未授权', '本地连接未就绪，暂时无法授权。', 'lock'],
  unavailable: ['此页面不支持控制', '浏览器内部页面和扩展商店无法控制，请切换到普通网页。', 'lock'],
  pending: ['正在授权…', '正在连接页面，可以随时停止。', 'refresh'],
  authorized: ['已授权，等待 AI 任务', '任务开始后会显示在这里。', 'shield'],
  active: ['正在控制中', '', 'pulse']
};
let busy = false, stopping = false, polling = false, dirty = false, editing = false, currentId = null;

const checked = name => document.querySelector('input[name="' + name + '"]:checked')?.value;
function check(name, value) {
  const input = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
  if (input) input.checked = true;
}
function use(svg, name) { svg.firstElementChild.setAttribute('href', '#i-' + name); }
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const ref = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  ref.setAttribute('href', '#i-' + name); svg.append(ref); return svg;
}
function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds < 10 ? '刚刚' : seconds < 60 ? seconds + ' 秒前' : seconds < 3600 ? Math.floor(seconds / 60) + ' 分钟前' : Math.floor(seconds / 3600) + ' 小时前';
}
function modeView() {
  el('extended-fields').hidden = checked('mode') !== 'extended';
  el('mode-note').textContent = modeNotes[checked('mode')] || '';
}
function options() {
  const mode = checked('mode');
  return { mode, minutes: Number(checked('minutes')), blocked_sites: mode === 'extended' ? el('blocked-sites').value.split(/\s+/).filter(Boolean) : [] };
}
el('settings').addEventListener('input', () => { dirty = true; modeView(); });
el('settings').addEventListener('submit', event => event.preventDefault());
el('edit').addEventListener('click', () => { editing = !editing; void refresh(); });

async function send(type, settings) {
  const response = await chrome.runtime.sendMessage({ type, ...(settings ? { options: settings } : {}) });
  if (response?.error) throw new Error(response.error.message);
  return response;
}
function showError(message) { el('error').textContent = message; el('error').hidden = !message; }

function renderEvents(recent) {
  const list = el('events'); list.replaceChildren();
  if (!recent.length) { const item = document.createElement('li'); item.className = 'empty'; item.textContent = '还没有操作记录'; list.append(item); }
  for (const event of recent) {
    // A stop records its reason as the code; that is the user's choice or a revocation, not a failure.
    const item = document.createElement('li'); item.classList.toggle('failed', event.code !== 'OK' && event.method !== 'stop');
    const badge = document.createElement('span'); badge.className = 'event-icon';
    badge.append(icon(icons[event.method] || 'pulse'));
    const label = document.createElement('span'); label.className = 'event-label';
    label.textContent = labels[event.method] || event.method;
    if (event.code !== 'OK') {
      const code = document.createElement('span'); code.className = 'event-code'; code.textContent = reasons[event.code] || event.code;
      item.title = event.code; label.append(code);
    }
    const meta = document.createElement('span'); meta.className = 'event-meta';
    meta.textContent = (event.elapsed_ms < 1000 ? event.elapsed_ms + ' ms' : (event.elapsed_ms / 1000).toFixed(1) + ' s') + (event.at ? ' · ' + ago(event.at) : '');
    item.append(badge, label, meta); list.append(item);
  }
}

async function refresh() {
  if (polling) return; polling = true;
  try {
    const state = await send('popup-status');
    el('version').textContent = state.version;
    el('status').textContent = state.connected ? '本地连接已就绪' : '本地连接未就绪';
    el('dot').classList.toggle('online', state.connected);
    el('reconnect').hidden = state.connected;
    el('connection-note').textContent = state.connection_error || '';
    el('connection-note').hidden = state.connected || !state.connection_error;
    el('session-id').textContent = state.session_id ? '连接 ID · ' + state.session_id : '';
    el('session-id').hidden = !state.connected || !state.session_id;

    const current = state.current;
    el('tab-title').textContent = current?.title || '没有可控制的标签页';
    el('tab-origin').textContent = current?.url || '请打开普通网页后再授权';
    el('site-avatar').textContent = (current?.url ? new URL(current.url).hostname.replace(/^www\./, '') : '·').charAt(0) || '·';

    const grant = state.grants.find(g => g.tab_id === current?.id);
    const pending = Boolean(state.pending_tab_ids?.includes(current?.id));
    if (currentId !== current?.id) { currentId = current?.id; dirty = false; editing = false; }
    if (!grant) editing = false;
    if (!dirty) {
      check('mode', grant?.mode || state.preferences?.mode || 'standard');
      check('minutes', String(grant?.authorization_minutes || state.preferences?.minutes || 30));
      el('blocked-sites').value = (grant?.mode === 'extended' ? grant.blocked_sites || [] : state.preferences?.blocked_sites || []).join('\n');
    }
    modeView();

    const view = pending ? 'pending' : grant?.controlled_by ? 'active' : grant ? 'authorized'
      : !current?.allowed ? 'unavailable' : !state.connected ? 'disconnected' : 'idle';
    document.body.dataset.view = view;
    const [headline, detail, glyph] = views[view];
    el('permission').textContent = headline;
    el('state-detail').textContent = view === 'active' ? '任务：' + grant.controlled_by : detail;
    use(el('state-glyph'), glyph);

    // Scope and remaining time of an existing grant.
    el('grant-info').hidden = !grant;
    const scope = grant?.mode === 'extended' ? '所有普通网站' + (grant.blocked_sites?.length ? '，排除 ' + grant.blocked_sites.length + ' 个域名' : '，无黑名单') : (grant?.allowed_origins || []).join('、');
    el('scope-summary').textContent = grant?.mode ? modeNames[grant.mode] + ' · ' + scope : '';
    el('scope-summary').hidden = !grant?.mode;
    const expires = grant?.authorization_expires_at, total = (grant?.authorization_minutes || 0) * 60_000;
    el('expiry').hidden = !expires;
    if (expires) {
      const left = Math.max(0, expires - Date.now()), minutes = Math.ceil(left / 60_000);
      el('expiry-text').textContent = left < 60_000 ? '不到 1 分钟后到期' : '剩余 ' + minutes + ' 分钟 · ' + new Date(expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 到期';
      const fraction = total ? Math.min(1, left / total) : 1;
      el('expiry-fill').style.width = (fraction * 100).toFixed(1) + '%';
      el('expiry-fill').classList.toggle('low', fraction < .15);
    }

    // Settings: shown before granting, or on demand to change an existing grant.
    const canConfigure = view === 'idle' || view === 'disconnected';
    el('settings').hidden = !(canConfigure || editing);
    el('edit').hidden = !grant || pending;
    el('edit').setAttribute('aria-expanded', String(editing));
    el('edit').lastElementChild.textContent = editing ? '收起设置' : '调整权限';
    el('grant').hidden = Boolean(grant || pending) || view === 'unavailable'; el('grant').disabled = busy || stopping || !state.connected || !current?.allowed;
    el('apply').hidden = !(grant && editing); el('apply').disabled = busy || stopping || !state.connected;
    el('stop').hidden = !(grant || pending); el('stop').disabled = stopping;
    el('trust').hidden = Boolean(grant || pending) || view === 'unavailable';
    el('stop-all').disabled = stopping || (!state.grants.length && !state.pending_tab_ids?.length);
    el('count').textContent = state.grants.length + ' 个标签页已授权';
    renderEvents(state.recent);
  } catch (error) { showError(error.message); } finally { polling = false; }
}
for (const [id, type] of [['grant', 'popup-grant'], ['apply', 'popup-apply'], ['stop', 'popup-revoke'], ['stop-all', 'popup-stop-all'], ['reconnect', 'popup-reconnect']]) {
  el(id).addEventListener('click', async () => {
    const isStop = type === 'popup-revoke' || type === 'popup-stop-all';
    if (isStop ? stopping : busy || stopping) return;
    if (isStop) stopping = true; else busy = true;
    el(id).disabled = true; showError('');
    try {
      await send(type, ['popup-grant', 'popup-apply'].includes(type) ? options() : undefined);
      dirty = false; if (type === 'popup-apply') editing = false;
    } catch (error) { showError(error.message); }
    finally { if (isStop) stopping = false; else busy = false; el(id).disabled = false; await refresh(); }
  });
}
void refresh();
const timer = setInterval(() => void refresh(), 1500);
window.addEventListener('unload', () => clearInterval(timer));
