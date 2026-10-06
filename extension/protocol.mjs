export const VERSION = '0.1.1';
export const WIRE_VERSION = 1;
export const HOST_NAME = 'com.localchrome.control';
export const LEASE_MS = 10 * 60 * 1000;
export const MAX_TEXT = 24_000;
export const MAX_NODES = 250;
// Write records only need to outlive any lease that could replay them; see Controller.saveRecord.
export const LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;
export const LEDGER_LIMIT = 5000;
export const MAX_SCREENSHOT_BASE64 = 5_000_000;
export const READ_METHODS = new Set(['status', 'tabs_list', 'page_snapshot', 'page_screenshot', 'request_status']);
export const MUTATIONS = new Set(['page_click', 'page_fill', 'page_select', 'page_navigate', 'page_press_key']);
// Scrolling moves the viewport but submits nothing, so it needs no request_id.
export const METHODS = new Set([...READ_METHODS, ...MUTATIONS, 'page_scroll', 'tab_claim', 'tab_release']);
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'];
export const MAX_SCROLL = 20_000;

// Only Shift is supported as a modifier: Control/Meta combinations reach clipboard and
// editing commands, which are outside what a tab grant covers.
const NAMED_KEYS = { Enter: [13, '\r'], Escape: [27], Tab: [9], Backspace: [8], Delete: [46], Space: [32, ' '],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34] };
const PUNCTUATION = [['/', '?', 'Slash', 191], ['.', '>', 'Period', 190], [',', '<', 'Comma', 188], ['-', '_', 'Minus', 189],
  ['=', '+', 'Equal', 187], ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], [';', ':', 'Semicolon', 186],
  ["'", '"', 'Quote', 222], ['`', '~', 'Backquote', 192], ['\\', '|', 'Backslash', 220]];
const SHIFTED_DIGITS = ')!@#$%^&*(';
export function keyDefinition(name) {
  if (typeof name !== 'string') return null;
  const shifted = name.startsWith('Shift+');
  const base = shifted ? name.slice(6) : name;
  if (Object.hasOwn(NAMED_KEYS, base)) {
    const [keyCode, text] = NAMED_KEYS[base];
    return { key: base === 'Space' ? ' ' : base, code: base, keyCode, text, shift: shifted };
  }
  // Printable characters carry their own shift state, e.g. 'A' or '?'.
  if (shifted || name.length !== 1) return null;
  if (/^[a-z]$/i.test(name)) return { key: name, code: 'Key' + name.toUpperCase(), keyCode: name.toUpperCase().charCodeAt(0), text: name, shift: name !== name.toLowerCase() };
  if (/^[0-9]$/.test(name)) return { key: name, code: 'Digit' + name, keyCode: name.charCodeAt(0), text: name, shift: false };
  const digit = SHIFTED_DIGITS.indexOf(name);
  if (digit >= 0) return { key: name, code: 'Digit' + digit, keyCode: 48 + digit, text: name, shift: true };
  const mark = PUNCTUATION.find(([plain, upper]) => name === plain || name === upper);
  return mark ? { key: name, code: mark[2], keyCode: mark[3], text: name, shift: name === mark[1] } : null;
}

export class ControlError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export function fail(code, message, details) { throw new ControlError(code, message, details); }
export function errorObject(error) {
  // Never return Chrome's raw error: it may contain page URLs or evaluated form text.
  return {
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.code ? error.message : '操作未完成；请查看连接状态并重新读取页面。',
    ...(error?.details ? { details: error.details } : {})
  };
}
export function webOrigin(url) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('INVALID_URL', '请输入有效的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('RESTRICTED_URL', '只支持普通 HTTP/HTTPS 页面，不接受带用户名或密码的 URL。');
  }
  if (parsed.hostname === 'chromewebstore.google.com' ||
      (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
    fail('RESTRICTED_URL', '不支持控制 Chrome 扩展商店或浏览器设置页面。');
  }
  return parsed.origin;
}
export function safeUrl(url) {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname; // Avoid leaking query tokens in connection metadata.
}
export function stringArg(value, name, max = 200) {
  if (typeof value !== 'string' || !value.length || value.length > max) {
    fail('INVALID_ARGUMENT', name + ' 必须是非空字符串，长度不超过 ' + max + '。');
  }
  return value;
}
export function validate(method, args = {}) {
  if (!METHODS.has(method)) fail('UNKNOWN_METHOD', '不支持的控制操作。');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_ARGUMENT', '参数必须是对象。');
  if (!['status', 'tabs_list', 'request_status'].includes(method)) {
    if (!Number.isSafeInteger(args.tab_id) || args.tab_id < 0) fail('INVALID_ARGUMENT', 'tab_id 无效。');
  }
  if (method === 'tab_claim') stringArg(args.task_name, 'task_name', 80);
  if (method.startsWith('page_') || method === 'tab_release') stringArg(args.lease_id, 'lease_id', 100);
  if (['page_click', 'page_fill', 'page_select'].includes(method)) {
    stringArg(args.snapshot_id, 'snapshot_id', 100);
    stringArg(args.ref, 'ref', 30);
  }
  if ((method === 'page_scroll' || method === 'page_press_key') && args.ref !== undefined) {
    stringArg(args.snapshot_id, 'snapshot_id', 100);
    stringArg(args.ref, 'ref', 30);
  }
  if (method === 'page_scroll') {
    if (!SCROLL_DIRECTIONS.includes(args.direction)) fail('INVALID_ARGUMENT', 'direction 必须是 up、down、left 或 right。');
    if (args.amount !== undefined && (!Number.isSafeInteger(args.amount) || args.amount < 1 || args.amount > MAX_SCROLL)) {
      fail('INVALID_ARGUMENT', 'amount 必须是 1–' + MAX_SCROLL + ' 的整数像素。');
    }
  }
  if (method === 'page_press_key' && !keyDefinition(args.key)) {
    fail('INVALID_ARGUMENT', '不支持的按键。可用 Enter、Escape、Tab、Backspace、Delete、Space、方向键、Home、End、PageUp、PageDown（可加 Shift+ 前缀），或单个字母、数字、符号。');
  }
  if (method === 'page_fill') {
    if (typeof args.value !== 'string' || args.value.length > 20_000) fail('INVALID_ARGUMENT', '填写内容最多 20,000 字符。');
  }
  if (method === 'page_select') stringArg(args.value, 'value', 500);
  if (method === 'page_navigate') { stringArg(args.url, 'url', 4000); webOrigin(args.url); }
  if (MUTATIONS.has(method) || method === 'request_status') {
    if (!/^[a-zA-Z0-9_-]{8,96}$/.test(args.request_id || '')) {
      fail('INVALID_ARGUMENT', 'request_id 必须是 8–96 位字母、数字、下划线或连字符，每次新操作使用新 ID。');
    }
  }
}
export async function fingerprint(method, args) {
  const content = [method, args.tab_id, args.lease_id, args.snapshot_id || '', args.ref || '', args.value ?? '', args.url || ''];
  if (args.key !== undefined) content.push(args.key); // Appended so earlier fingerprints stay unchanged.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
export function deadlineCheck(deadline) {
  if (Date.now() >= deadline) fail('TIMEOUT', '操作等待时间已到；不会自动重试。');
}
