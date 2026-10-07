import { webOrigin, fail, MUTATIONS } from './protocol.mjs';

export const MODES = ['readonly', 'standard', 'extended'];
export const MAX_SCOPE_MINUTES = 120;
export function normalizeBlockedSites(values) {
  if (!Array.isArray(values) || values.length > 200) fail('INVALID_SCOPE', '黑名单最多 200 项。');
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\s*\\]/.test(value.trim())) {
      fail('INVALID_SCOPE', '黑名单请输入域名或完整 HTTP/HTTPS 网址，不使用通配符。');
    }
    const text = value.trim(), full = /^https?:\/\//i.test(text);
    let url;
    try { url = new URL(full ? text : 'https://' + text); } catch { fail('INVALID_SCOPE', '黑名单中有无效的网站地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        !full && (url.pathname !== '/' || url.search || url.hash)) fail('INVALID_SCOPE', '黑名单请输入域名或 HTTP/HTTPS 网址，不含登录凭据。');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253 || !host.startsWith('[') && host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      fail('INVALID_SCOPE', '黑名单中有无效的域名。');
    }
    return host;
  }))];
}
export function createPolicy(origin, options = {}, now = Date.now()) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(k => !['mode', 'blocked_sites', 'minutes'].includes(k))) fail('INVALID_SCOPE', '不支持的授权设置。');
  origin = webOrigin(origin);
  const mode = options.mode ?? 'standard';
  if (!MODES.includes(mode)) fail('INVALID_SCOPE', '请选择只读、标准或扩展模式。');
  const blocked = normalizeBlockedSites(options.blocked_sites === undefined ? [] : options.blocked_sites);
  if (mode !== 'extended' && blocked.length) fail('INVALID_SCOPE', '黑名单设置用于扩展模式。');
  const minutes = options.minutes ?? 30;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_SCOPE_MINUTES) fail('INVALID_SCOPE', '授权有效期须为 1–120 分钟。');
  const policy = { mode, scope_kind: mode === 'extended' ? 'all_websites_except_blocked' : 'current_origin',
    origins: mode === 'extended' ? [] : [origin], frame_origins: [], blocked_sites: blocked,
    minutes, expires_at: now + minutes * 60_000 };
  return policy;
}
export function permitsOrigin(policy, origin, frame = false, topOrigin = '') {
  let canonical;
  try { canonical = webOrigin(origin); } catch { return false; }
  if (policy.mode === 'extended') {
    // Only the new explicit scope grants broad access; old policy objects fail closed.
    if (policy.scope_kind !== 'all_websites_except_blocked' || !Array.isArray(policy.blocked_sites)) return false;
    const host = new URL(canonical).hostname.toLowerCase().replace(/\.$/, '');
    return !policy.blocked_sites.some(blocked => host === blocked ||
      !blocked.startsWith('[') && !/^\d+\.\d+\.\d+\.\d+$/.test(blocked) && host.endsWith('.' + blocked));
  }
  return frame ? canonical === topOrigin : policy.origins.includes(canonical);
}
export function checkMethod(policy, method) {
  if (policy.mode === 'readonly' && (MUTATIONS.has(method) || method === 'page_scroll')) {
    fail('READ_ONLY_MODE', '这个标签页为只读模式；点击、输入、滚动与跳转需要用户在弹窗里改为标准或扩展模式。');
  }
}
