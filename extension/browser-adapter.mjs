import { MAX_TEXT, MAX_NODES, MAX_SCREENSHOT_BASE64, ControlError, fail, deadlineCheck, keyDefinition } from './protocol.mjs';
import { snapshotPage, prepareAction, viewportMetrics, focusedElement, scrollMetrics } from './page-world.mjs';

const PAGE_ERRORS = ['ORIGIN_CHANGED', 'STALE_SNAPSHOT', 'STALE_REF', 'ELEMENT_CHANGED', 'ELEMENT_DISABLED', 'ELEMENT_HIDDEN', 'ELEMENT_OBSCURED', 'UNSUPPORTED_INPUT', 'INVALID_OPTION', 'NOT_FOCUSABLE', 'FOCUS_CHANGED', 'SCROLL_TARGET_LOST'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class BrowserAdapter {
  constructor(api) { this.api = api; this.worlds = new Map(); }
  tab(id) { return this.api.tabs.get(id); }
  forget(id) { this.worlds.delete(id); }
  async attach(id) {
    try { await this.api.debugger.attach({ tabId: id }, '1.3'); }
    catch {
      // A restarted worker can still own Chrome's attachment. Only a fresh user grant
      // enters this method; probe our own debugger session without taking over another one.
      try { await this.cdp(id, 'Page.getFrameTree', {}, Date.now() + 2000); }
      catch { fail('DEBUGGER_ATTACH_FAILED', '无法取得页面控制权。请结束其他调试工具对此标签页的控制，再点击授权。'); }
    }
    this.forget(id);
  }
  async detach(id) { this.forget(id); await this.api.debugger.detach({ tabId: id }); }
  async detachOrphans() {
    // Chrome only lets an extension detach its own sessions; other debuggers reject this.
    const targets = await this.api.debugger.getTargets();
    await Promise.all(targets.filter(t => t.attached && Number.isSafeInteger(t.tabId))
      .map(t => this.api.debugger.detach({ tabId: t.tabId }).catch(() => {})));
  }
  async cdp(id, method, params, deadline) {
    deadlineCheck(deadline);
    let timer;
    try {
      return await Promise.race([
        this.api.debugger.sendCommand({ tabId: id }, method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new ControlError('TIMEOUT', 'Chrome 没有在时限内返回结果。')), Math.max(1, deadline - Date.now())); })
      ]);
    } catch (error) {
      if (error.code) throw error;
      if (/not attached|unattached|No tab/i.test(error.message || '')) {
        this.forget(id);
        fail('DEBUGGER_LOST', 'Chrome 控制连接已断开，请在扩展里重新授权。');
      }
      if (/Cannot find context|Execution context was destroyed|Cannot find.*executionContext|Inspected target navigated/i.test(error.message || '')) {
        this.forget(id);
        fail('CONTEXT_LOST', '页面已刷新，旧元素引用失效。请重新读取页面。');
      }
      fail('BROWSER_COMMAND_FAILED', 'Chrome 未完成控制指令，请重新读取页面检查状态。');
    } finally { clearTimeout(timer); }
  }
  async world(id, deadline) {
    if (this.worlds.has(id)) return this.worlds.get(id);
    const tree = await this.cdp(id, 'Page.getFrameTree', {}, deadline);
    const result = await this.cdp(id, 'Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id, worldName: 'local-chrome-control-v1', grantUniveralAccess: false
    }, deadline);
    this.worlds.set(id, result.executionContextId);
    return result.executionContextId;
  }
  async evaluate(id, fn, params, deadline) {
    const contextId = await this.world(id, deadline);
    const expression = '(' + fn.toString() + ')(' + params.map(p => JSON.stringify(p)).join(',') + ')';
    const response = await this.cdp(id, 'Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: false }, deadline);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || '';
      const code = PAGE_ERRORS.find(c => description.includes(c));
      if (code) fail(code, '页面元素或授权状态已变化，请读取新快照后再决定操作。');
      fail('PAGE_EVALUATION_FAILED', '页面读取未完成，请重新获取快照。');
    }
    return response.result?.value;
  }
  async screenshotClip(id, origin, deadline) {
    let view;
    try { view = await this.evaluate(id, viewportMetrics, [origin], deadline); }
    catch (error) {
      if (['PAGE_EVALUATION_FAILED', 'CONTEXT_LOST', 'BROWSER_COMMAND_FAILED'].includes(error.code)) return undefined;
      throw error;
    }
    // Capture at CSS-pixel size: Retina device pixels only add bytes and model tokens.
    return { x: view.x, y: view.y, width: view.width, height: view.height, scale: Math.min(1, 1 / (view.dpr || 1)) };
  }
  async prepare(id, args, origin, operation, value, deadline, guard, progress, check) {
    const target = await this.evaluate(id, prepareAction, [origin, args.snapshot_id, args.ref, 'check-' + operation, value], deadline);
    check?.(target);
    await guard();
    // scrollIntoView/focus can run page handlers. Once this evaluation is sent,
    // even a recognized page error is no longer proof that nothing happened.
    progress.dispatched = true;
    return this.evaluate(id, prepareAction, [origin, args.snapshot_id, args.ref, operation, value], deadline);
  }
  // "dispatched" includes side-effecting preparation, not just the final input event.
  async run(method, args, origin, deadline, guard, progress = {}) {
    const id = args.tab_id;
    await guard();
    if (method === 'page_snapshot') {
      const snapshot = await this.evaluate(id, snapshotPage, [origin, crypto.randomUUID(), MAX_TEXT, MAX_NODES], deadline);
      // Tells the caller where a key press without ref would land.
      return { ...snapshot, focused: await this.evaluate(id, focusedElement, [origin], deadline) };
    }
    if (method === 'page_screenshot') {
      const clip = await this.screenshotClip(id, origin, deadline);
      const result = await this.cdp(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false, ...(clip ? { clip } : {}) }, deadline);
      if (!result.data || result.data.length > MAX_SCREENSHOT_BASE64) fail('SCREENSHOT_TOO_LARGE', '截图超过大小限制，请缩小浏览器窗口后再试。');
      return { mime_type: 'image/jpeg', data: result.data };
    }
    if (method === 'page_navigate') {
      this.forget(id);
      deadlineCheck(deadline);
      progress.dispatched = true;
      const result = await this.cdp(id, 'Page.navigate', { url: args.url }, deadline);
      if (result.errorText) fail('NAVIGATION_FAILED', 'Chrome 未完成页面跳转。');
      return { navigated: true };
    }
    if (method === 'page_click') {
      const point = await this.prepare(id, args, origin, 'point', '', deadline, guard, progress);
      await guard();
      // Check the element again after any asynchronous work, then use trusted CDP input events.
      const checked = await this.prepare(id, args, origin, 'point', '', deadline, guard, progress);
      if (Math.abs(point.x - checked.x) > 2 || Math.abs(point.y - checked.y) > 2) fail('ELEMENT_MOVED', '元素位置变化，请重新读取页面。');
      await guard();
      progress.dispatched = true;
      try {
        await this.cdp(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: checked.x, y: checked.y, button: 'left', clickCount: 1 }, deadline);
      } finally {
        // Release even when the press reply is lost; never leave the user's mouse held down.
        await this.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: checked.x, y: checked.y, button: 'left', clickCount: 1 }, Math.max(deadline, Date.now() + 1000));
      }
      return { clicked: true };
    }
    if (method === 'page_fill' || method === 'page_select') {
      return this.prepare(id, args, origin, method === 'page_fill' ? 'fill' : 'select', args.value, deadline, guard, progress);
    }
    if (method === 'page_scroll') return this.scroll(id, args, origin, deadline, guard);
    if (method === 'page_press_key') return this.pressKey(id, args, origin, deadline, guard, progress);
    fail('UNKNOWN_METHOD', '不支持的浏览器操作。');
  }
  async scroll(id, args, origin, deadline, guard) {
    const trackingId = crypto.randomUUID();
    // A ref picks the scroll area under that element (dialogs, sidebars); otherwise the page.
    const point = args.ref ? await this.prepare(id, args, origin, 'point', '', deadline, guard, {}) : null;
    const measure = () => this.evaluate(id, scrollMetrics, [origin, args.snapshot_id || '', args.ref || '', args.direction, point, trackingId], deadline);
    const before = await measure();
    const vertical = args.direction === 'up' || args.direction === 'down';
    const sign = args.direction === 'up' || args.direction === 'left' ? -1 : 1;
    const amount = args.amount || Math.max(1, Math.round((vertical ? before.view_height : before.view_width) * 0.8));
    const at = before.point || point || { x: Math.floor(before.view_width / 2), y: Math.floor(before.view_height / 2) };
    await guard();
    // A trusted wheel event scrolls whatever is under the pointer and triggers lazy loading.
    await this.cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y,
      deltaX: vertical ? 0 : sign * amount, deltaY: vertical ? sign * amount : 0 }, deadline);
    // Wheel scrolling may animate; wait until two readings agree.
    let after = before;
    for (let i = 0; i < 10 && deadline - Date.now() > 500; i++) {
      await pause(100);
      const next = await measure();
      const settled = JSON.stringify(next.positions || [next.x, next.y]) === JSON.stringify(after.positions || [after.x, after.y]) && i > 0;
      after = next;
      if (settled) break;
    }
    const position = vertical ? after.y : after.x;
    const limit = vertical ? after.height - after.view_height : after.width - after.view_width;
    return { moved: after.moved ?? (after.x !== before.x || after.y !== before.y), container: after.ambiguous ? 'multiple' : after.container,
      scroll_x: after.x, scroll_y: after.y, scroll_width: after.width, scroll_height: after.height,
      viewport_width: after.view_width, viewport_height: after.view_height,
      reached_end: after.ambiguous ? null : sign < 0 ? position <= 1 : position >= limit - 1,
      note: after.ambiguous ? '多个滚动区域发生变化，无法确定单个边界；请重新读取快照确认。' : '新出现的内容需要重新读取快照。' };
  }
  checkKeyTarget(target, args, key) {
    if (target?.frame) fail('FOCUS_IN_FRAME', '键盘焦点在内嵌框架中，请用 ref 指定主页面元素。');
    if (target?.shadow || target?.unverified) fail('UNVERIFIED_FOCUS', '无法确认实际键盘目标（可能位于 Shadow DOM 内）。请指定主页面的原生控件；此处不发送按键。');
    if (target?.password && !['Tab', 'Escape'].includes(key.key)) fail('UNSUPPORTED_INPUT', '密码框只允许离开焦点或关闭提示；输入、编辑和提交需由用户操作。');
    if (target?.input_type === 'file') fail('UNSUPPORTED_INPUT', '不向文件选择框发送按键。');
    // A body focus could also mask a closed shadow root. Printable/editing input needs
    // an identified native target; callers can focus a native control for site shortcuts.
    if (!target && !['Tab', 'Escape'].includes(key.key)) {
      fail('UNVERIFIED_FOCUS', '此按键需要已确认的原生控件焦点，请传入该控件的 ref；翻页请用 page_scroll。');
    }
    if (!args.ref && target?.media) fail('FOCUS_ON_MEDIA', '键盘焦点在视频或音频播放器上。滚动请用 page_scroll；控制原生播放器请传其 ref。');
  }
  async pressKey(id, args, origin, deadline, guard, progress) {
    const key = keyDefinition(args.key);
    if (args.ref) await this.prepare(id, args, origin, 'focus', '', deadline, guard, progress,
      target => this.checkKeyTarget(target, args, key));
    const readTarget = () => this.evaluate(id, focusedElement, [origin, args.snapshot_id || '', args.ref || ''], deadline);
    const target = await readTarget();
    this.checkKeyTarget(target, args, key);
    await guard();
    // Recheck after the asynchronous permission/lease guard, immediately before input.
    const checked = await readTarget();
    this.checkKeyTarget(checked, args, key);
    if (JSON.stringify(checked) !== JSON.stringify(target)) fail('FOCUS_CHANGED', '键盘目标已变化，请重新读取快照；没有发送按键。');
    deadlineCheck(deadline);
    progress.dispatched = true;
    const event = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: key.shift ? 8 : 0 };
    try {
      await this.cdp(id, 'Input.dispatchKeyEvent', key.text ? { ...event, type: 'keyDown', text: key.text, unmodifiedText: key.text } : { ...event, type: 'rawKeyDown' }, deadline);
    } finally {
      // Release even when the press reply is lost; never leave a key held down.
      await this.cdp(id, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' }, Math.max(deadline, Date.now() + 1000));
    }
    // Page-derived details are returned to the caller but not stored in the write ledger.
    return { details: { pressed: args.key, target: checked } };
  }
}
