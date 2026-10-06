// These functions execute in an extension-owned isolated world, not the page's JavaScript world.
// They inspect only rendered DOM; cookies, storage and hidden inputs are never read.
export function snapshotPage(expectedOrigin, snapshotId, maxText, maxNodes) {
  if (location.origin !== expectedOrigin) throw new Error('ORIGIN_CHANGED');
  const visible = el => {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.getClientRects().length > 0;
  };
  const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = el => {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return (el.getAttribute('aria-label') || ids.map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ') ||
      (el.labels ? [...el.labels].map(text).join(' ') : '') ||
      el.getAttribute('alt') || el.getAttribute('placeholder') ||
      (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) ? text(el) : '') || el.getAttribute('title') || '').slice(0, 250);
  };
  // Keep target identity inside the isolated world. Do not export form action URLs.
  const options = el => el.tagName === 'SELECT' ? [...el.options].slice(0, 100).map(o => ({
    value: o.value, label: o.label, disabled: Boolean(o.disabled || (o.parentElement?.tagName === 'OPTGROUP' && o.parentElement.disabled))
  })) : null;
  const identity = el => JSON.stringify([el.tagName, (el.getAttribute('type') || '').toLowerCase(), label(el),
    el.getAttribute('name'), el.getAttribute('role'), el.tagName === 'A' ? el.href : null,
    el.form?.action, el.form?.method, el.getAttribute('formaction'), el.getAttribute('formmethod'),
    el.getAttribute('target'), el.getAttribute('download'), options(el)]);
  const state = { snapshotId, refs: new Map() };
  window.__localChromeControl = state;
  const nodes = [];
  const selector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  let total = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    total++;
    if (nodes.length >= maxNodes) continue;
    const ref = 'e' + (nodes.length + 1);
    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = label(el);
    state.refs.set(ref, { el, tag: el.tagName, type, name, identity, signature: identity(el), options: options(el) });
    const node = { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label: name,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true') };
    if (type) node.input_type = type;
    if ('value' in el && !['password', 'file'].includes(type)) node.value = String(el.value).slice(0, 2000);
    if (type === 'password') node.value = '[redacted]';
    if ('checked' in el && ['checkbox', 'radio'].includes(type)) node.checked = el.checked;
    if (el.tagName === 'SELECT') node.options = options(el);
    nodes.push(node);
  }
  let pageText = document.body?.innerText || '';
  // innerText does not include password input values; never serialize form attributes or page HTML.
  const frames = [...document.querySelectorAll('iframe')].filter(visible).map(frame => ({ title: frame.title || '', supported: false }));
  return { snapshot_id: snapshotId, title: document.title, url: location.origin + location.pathname,
    text: pageText.slice(0, maxText), elements: nodes, frames,
    truncated: pageText.length > maxText || total > maxNodes,
    limitations: frames.length ? ['第一版操作范围为主页面；iframe 内容需用户操作。'] : [] };
}

export function viewportMetrics(expectedOrigin) {
  if (location.origin !== expectedOrigin) throw new Error('ORIGIN_CHANGED');
  const view = visualViewport;
  return { x: view.pageLeft, y: view.pageTop, width: view.width, height: view.height, dpr: devicePixelRatio };
}

// Reports where keystrokes would go. Labels are trimmed; input values are never read.
export function focusedElement(expectedOrigin, snapshotId = '', ref = '') {
  if (location.origin !== expectedOrigin) throw new Error('ORIGIN_CHANGED');
  const el = document.activeElement;
  if (ref) {
    const state = window.__localChromeControl;
    if (!state || state.snapshotId !== snapshotId) throw new Error('STALE_SNAPSHOT');
    const item = state.refs.get(ref);
    if (!item || !item.el.isConnected) throw new Error('STALE_REF');
    if (item.identity(item.el) !== item.signature) throw new Error('ELEMENT_CHANGED');
    if (el !== item.el) throw new Error('FOCUS_CHANGED');
  }
  if (!el || el === document.body || el === document.documentElement) return null;
  // Closed shadow roots cannot be inspected from this world. Only native focus targets
  // whose tags cannot host shadow roots are trusted for key input; custom hosts fail closed.
  const native = /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY|VIDEO|AUDIO|IFRAME|FRAME)$/.test(el.tagName);
  let focus = window.__localChromeFocus;
  if (!focus || focus.el !== el) {
    const sequence = (window.__localChromeFocusSequence || 0) + 1;
    window.__localChromeFocusSequence = sequence;
    focus = window.__localChromeFocus = { el, id: String(sequence) };
  }
  const type = (el.getAttribute('type') || '').toLowerCase();
  const label = (el.getAttribute('aria-label') || (el.labels ? [...el.labels].map(l => l.innerText).join(' ') : '') ||
    el.getAttribute('placeholder') || el.getAttribute('title') || (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) ? el.innerText : '') || '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  const entry = window.__localChromeControl ? [...window.__localChromeControl.refs].find(([, item]) => item.el === el) : null;
  return { tag: el.tagName.toLowerCase(), label, focus_id: focus.id,
    ...(type ? { input_type: type } : {}), ...(entry ? { ref: entry[0] } : {}),
    frame: el.tagName === 'IFRAME' || el.tagName === 'FRAME', password: el.tagName === 'INPUT' && type === 'password',
    shadow: Boolean(el.shadowRoot), unverified: !native,
    // Players take Space, arrows, Home/End and letters as playback controls.
    media: el.matches('video,audio') || Boolean(el.querySelector('video,audio')) };
}

// Measures the page, or the nearest scrollable container around a snapshot element.
export function scrollMetrics(expectedOrigin, snapshotId, ref, direction = 'down', point = null, trackingId = '') {
  if (location.origin !== expectedOrigin) throw new Error('ORIGIN_CHANGED');
  const root = document.scrollingElement || document.documentElement;
  const vertical = direction === 'up' || direction === 'down';
  const negative = direction === 'up' || direction === 'left';
  let anchor = null;
  if (ref) {
    const state = window.__localChromeControl;
    if (!state || state.snapshotId !== snapshotId) throw new Error('STALE_SNAPSHOT');
    const item = state.refs.get(ref);
    if (!item || !item.el.isConnected) throw new Error('STALE_REF');
    anchor = item.el;
  }
  const at = point || { x: Math.floor(innerWidth / 2), y: Math.floor(innerHeight / 2) };
  const metrics = box => ({ container: box === root ? 'page' : 'element',
    x: Math.round(box.scrollLeft), y: Math.round(box.scrollTop), width: box.scrollWidth, height: box.scrollHeight,
    view_width: box === root ? innerWidth : box.clientWidth, view_height: box === root ? innerHeight : box.clientHeight });
  let tracking = trackingId && window.__localChromeScroll;
  if (!trackingId || !tracking || tracking.id !== trackingId) {
    const hit = document.elementFromPoint(at.x, at.y);
    if (point && anchor && (!hit || !(anchor === hit || anchor.contains(hit)))) throw new Error('ELEMENT_OBSCURED');
    const boxes = [];
    let barrier = false;
    for (let el = hit || anchor; el && el !== root; el = el.parentElement) {
      const style = getComputedStyle(el);
      const overflow = vertical ? style.overflowY : style.overflowX;
      const extent = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (/^(auto|scroll|overlay)$/.test(overflow) && extent > 0) boxes.push({ el, before: metrics(el) });
      const boundary = style.getPropertyValue(vertical ? 'overscroll-behavior-y' : 'overscroll-behavior-x') || style.overscrollBehavior || '';
      if (/^(contain|none)$/.test(boundary)) {
        barrier = true;
        if (!boxes.length) boxes.push({ el, before: metrics(el) });
        break;
      }
    }
    if (!barrier) {
      if (!boxes.some(box => box.el === root)) boxes.push({ el: root, before: metrics(root) });
    }
    const preferred = boxes.find(box => {
      const m = box.before, position = vertical ? m.y : m.x;
      const limit = vertical ? m.height - m.view_height : m.width - m.view_width;
      return negative ? position > 1 : position < limit - 1;
    }) || boxes[0];
    tracking = { id: trackingId, direction, boxes, preferred };
    if (trackingId) window.__localChromeScroll = tracking;
  }
  if (tracking.direction !== direction || tracking.boxes.some(box => !box.el.isConnected)) throw new Error('SCROLL_TARGET_LOST');
  const readings = tracking.boxes.map(box => ({ box, current: metrics(box.el) }));
  const moved = readings.filter(({ box, current }) => current.x !== box.before.x || current.y !== box.before.y);
  const chosen = moved.length === 1 ? moved[0] : readings.find(item => item.box === tracking.preferred);
  return { ...chosen.current, point: at, ambiguous: moved.length > 1,
    moved: moved.length > 0, positions: readings.map(item => [item.current.x, item.current.y]) };
}

export function prepareAction(expectedOrigin, snapshotId, ref, operation, value) {
  const fail = code => { throw new Error(code); };
  if (location.origin !== expectedOrigin) fail('ORIGIN_CHANGED');
  const state = window.__localChromeControl;
  if (!state || state.snapshotId !== snapshotId) fail('STALE_SNAPSHOT');
  const item = state.refs.get(ref);
  if (!item || !item.el.isConnected) fail('STALE_REF');
  const el = item.el;
  if (item.identity(el) !== item.signature) fail('ELEMENT_CHANGED');
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') fail('ELEMENT_DISABLED');
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' ||
      el.closest('[hidden],[inert],[aria-hidden="true"]') || !el.getClientRects().length) fail('ELEMENT_HIDDEN');
  const checking = operation.startsWith('check-');
  const action = checking ? operation.slice(6) : operation;
  if (!['point', 'focus', 'fill', 'select'].includes(action)) fail('UNSUPPORTED_ACTION');
  if (action === 'fill' && (!['INPUT', 'TEXTAREA'].includes(el.tagName) || el.readOnly ||
      (el.tagName === 'INPUT' && !['', 'text', 'search', 'email', 'tel', 'url', 'number'].includes(item.type)))) fail('UNSUPPORTED_INPUT');
  if (action === 'select' && (el.tagName !== 'SELECT' || !item.options.some(o => o.value === value && !o.disabled))) fail('INVALID_OPTION');
  // This branch is pure: failures here can truthfully be reported as executed:false.
  // Scrolling or focusing below may trigger page handlers even if the action later fails.
  if (checking) return { checked: true, tag: el.tagName.toLowerCase(), input_type: item.type,
    frame: /^(IFRAME|FRAME)$/.test(el.tagName), password: el.tagName === 'INPUT' && item.type === 'password',
    shadow: Boolean(el.shadowRoot), unverified: !/^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY|VIDEO|AUDIO|IFRAME|FRAME)$/.test(el.tagName) };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
  const top = document.elementFromPoint(x, y);
  if (!top || !(el === top || el.contains(top))) fail('ELEMENT_OBSCURED');
  if (action === 'point') return { x, y };
  if (action === 'focus') {
    el.focus();
    if (document.activeElement !== el) fail('NOT_FOCUSABLE');
    return { focused: true };
  }
  if (action === 'fill') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true };
  }
  if (action === 'select') {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: true };
  }
  fail('UNSUPPORTED_ACTION');
}
