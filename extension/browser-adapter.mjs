import { FrameRouter } from './frames.mjs';
import { MAX_TEXT, MAX_NODES, MAX_SCREENSHOT_BASE64, ControlError, fail, deadlineCheck, keyDefinition } from './protocol.mjs';
import { snapshotPage, prepareAction, viewportMetrics, focusedElement, scrollMetrics, focusedNode, renderingReady } from './page-world.mjs';

const PAGE_ERRORS = ['ORIGIN_CHANGED', 'STALE_SNAPSHOT', 'STALE_REF', 'ELEMENT_CHANGED', 'ELEMENT_DISABLED', 'ELEMENT_HIDDEN', 'ELEMENT_OBSCURED', 'UNSUPPORTED_INPUT', 'INVALID_OPTION', 'NOT_FOCUSABLE', 'FOCUS_CHANGED', 'SCROLL_TARGET_LOST', 'FRAME_TARGET_REQUIRED'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class BrowserAdapter {
  constructor(api) { this.api = api; this.worlds = new Map(); this.frames = new FrameRouter(this); }
  async tab(id) {
    const tab = await this.api.tabs.get(id);
    if (this.frames.enabled.has(id)) {
      // Frame metadata stays usable while TargetInfo's URL briefly clears during
      // navigation. Never replace a current URL with that transient empty value.
      if (!tab.url) {
        const tree = await this.cdp(id, 'Page.getFrameTree', {}, Date.now() + 2000);
        tab.url = tree.frameTree?.frame?.url;
      }
      if (!tab.title) {
        const { targetInfo } = await this.cdp(id, 'Target.getTargetInfo', {}, Date.now() + 2000);
        if (!targetInfo || targetInfo.type !== 'page') fail('CONTEXT_LOST', '无法确认当前标签页。');
        tab.title = targetInfo.title || '';
      }
    }
    return tab;
  }
  forget(id) {
    this.worlds.delete(id);
    for (const key of this.worlds.keys()) if (typeof key === 'string' && key.startsWith(id + ':')) this.worlds.delete(key);
    this.frames.forget(id);
  }
  async attach(id) {
    try { await this.api.debugger.attach({ tabId: id }, '1.3'); }
    catch {
      // A restarted worker can still own Chrome's attachment. Only a fresh user grant
      // enters this method; probe our own debugger session without taking over another one.
      try { await this.cdp(id, 'Page.getFrameTree', {}, Date.now() + 2000); }
      catch { fail('DEBUGGER_ATTACH_FAILED', '无法取得页面控制权。请结束其他调试工具对此标签页的控制，再点击授权。'); }
    }
    this.forget(id);
    await this.frames.enable(id);
  }
  async detach(id) { this.frames.disable(id); this.forget(id); await this.api.debugger.detach({ tabId: id }); }
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
        this.api.debugger.sendCommand(typeof id === 'number' ? { tabId: id } : { tabId: id.tabId, ...(id.sessionId ? { sessionId: id.sessionId } : {}) }, method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new ControlError('TIMEOUT', 'Chrome 没有在时限内返回结果。')), Math.max(1, deadline - Date.now())); })
      ]);
    } catch (error) {
      if (error.code) throw error;
      if (/not attached|unattached|No tab/i.test(error.message || '')) {
        this.forget(typeof id === 'number' ? id : id.tabId);
        fail('DEBUGGER_LOST', 'Chrome 控制连接已断开，请在扩展里重新授权。');
      }
      if (/Cannot find context|Execution context was destroyed|Cannot find.*executionContext|Inspected target navigated/i.test(error.message || '')) {
        this.forget(typeof id === 'number' ? id : id.tabId);
        fail('CONTEXT_LOST', '页面已刷新，旧元素引用失效。请重新读取页面。');
      }
      fail('BROWSER_COMMAND_FAILED', 'Chrome 未完成控制指令，请重新读取页面检查状态。', { command: method });
    } finally { clearTimeout(timer); }
  }
  async world(id, deadline) {
    const key = typeof id === 'number' ? id : `${id.tabId}:${id.sessionId || ''}:${id.frameId || ''}`;
    if (this.worlds.has(key)) return this.worlds.get(key);
    const tree = id.frameId ? null : await this.cdp(id, 'Page.getFrameTree', {}, deadline);
    const result = await this.cdp(id, 'Page.createIsolatedWorld', {
      frameId: id.frameId || tree.frameTree.frame.id, worldName: 'local-chrome-control-v1', grantUniveralAccess: false
    }, deadline);
    this.worlds.set(key, result.executionContextId);
    return result.executionContextId;
  }
  async evaluate(id, fn, params, deadline, awaitPromise = false) {
    const contextId = await this.world(id, deadline);
    const expression = '(' + fn.toString() + ')(' + params.map(p => JSON.stringify(p)).join(',') + ')';
    const response = await this.cdp(id, 'Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise }, deadline);
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
  async run(method, args, origin, deadline, guard, progress = {}, policy = { mode: 'standard', origins: [origin], frame_origins: [] }) {
    const rootId = args.tab_id;
    const route = this.frames.route(args, policy, origin);
    const id = route?.target || rootId;
    if (route) { args = { ...args, ref: route.localRef }; origin = route.origin; }
    await guard();
    if (method === 'page_snapshot') {
      if (this.frames.enabled.has(rootId)) return this.frames.snapshot(rootId, origin, deadline, guard, policy);
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
      this.forget(rootId);
      deadlineCheck(deadline);
      progress.dispatched = true;
      const result = await this.cdp(id, 'Page.navigate', { url: args.url }, deadline);
      if (result.errorText) fail('NAVIGATION_FAILED', 'Chrome 未完成页面跳转。');
      return { navigated: true };
    }
    if (method === 'page_click') {
      const point = await this.prepare(id, args, origin, 'point', '', deadline, guard, progress);
      await guard();
      if (route?.target.sessionId) {
        const rootOrigin = this.frames.origin(route.trees.get(route.rootId).frame);
        await this.evaluate(rootId, renderingReady, [rootOrigin], deadline, true);
        await guard();
      }
      // Check the element again after any asynchronous work, then use trusted CDP input events.
      const checked = await this.evaluate(id, prepareAction, [origin, args.snapshot_id, args.ref, 'measure-point', ''], deadline);
      if (Math.abs(point.x - checked.x) > 2 || Math.abs(point.y - checked.y) > 2) fail('ELEMENT_MOVED', '元素位置变化，请重新读取页面。');
      await guard();
      const inputPoint = route ? await this.frames.point(route, checked, deadline, guard) : checked;
      await guard();
      progress.dispatched = true;
      await this.cdp(rootId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: inputPoint.x, y: inputPoint.y, button: 'none', buttons: 0 }, deadline);
      await guard();
      // Hover handlers can move or cover the target. Recheck before pressing.
      const hovered = await this.evaluate(id, prepareAction, [origin, args.snapshot_id, args.ref, 'measure-point', ''], deadline);
      const hoveredPoint = route ? await this.frames.point(route, hovered, deadline, guard) : hovered;
      if (Math.abs(inputPoint.x - hoveredPoint.x) > 2 || Math.abs(inputPoint.y - hoveredPoint.y) > 2) fail('ELEMENT_MOVED', '悬停后元素位置变化，请重新读取页面。');
      await guard();
      try {
        await this.cdp(rootId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: hoveredPoint.x, y: hoveredPoint.y, button: 'left', buttons: 1, clickCount: 1 }, deadline);
      } finally {
        // Release even when the press reply is lost; never leave the user's mouse held down.
        await this.cdp(rootId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: hoveredPoint.x, y: hoveredPoint.y, button: 'left', buttons: 0, clickCount: 1 }, Math.max(deadline, Date.now() + 1000));
      }
      return { clicked: true };
    }
    if (method === 'page_fill' || method === 'page_select') {
      const result = await this.prepare(id, args, origin, method === 'page_fill' ? 'fill' : 'select', args.value, deadline, guard, progress);
      if (result.ready_for_input) await this.insertText(id, rootId, args, origin, deadline, guard, progress, args.value, false, route);
      return result;
    }
    if (method === 'page_type_text') {
      if (!args.value.length) { await this.evaluate(id, prepareAction, [origin, args.snapshot_id, args.ref, 'check-type', ''], deadline); return { details: { inserted_characters: 0, mode: args.mode || 'insert' } }; }
      await this.prepare(id, args, origin, 'type', args.value, deadline, guard, progress);
      await this.insertText(id, rootId, args, origin, deadline, guard, progress, args.value, args.mode === 'characters', route);
      return { details: { inserted_characters: Array.from(args.value).length, mode: args.mode || 'insert' } };
    }
    if (method === 'page_scroll') return this.scroll(id, args, origin, deadline, guard, route);
    if (method === 'page_press_key') return this.pressKey(id, args, origin, deadline, guard, progress, route);
    fail('UNKNOWN_METHOD', '不支持的浏览器操作。');
  }
  async scroll(id, args, origin, deadline, guard, route) {
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
    const inputPoint = route ? await this.frames.point(route, at, deadline, guard) : at;
    await guard();
    await this.cdp(typeof id === 'number' ? id : id.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: inputPoint.x, y: inputPoint.y,
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
  async verifyEditor(id, args, origin, deadline) {
    const contextId = await this.world(id, deadline);
    const expression = '(' + focusedNode.toString() + ')(' + [origin, args.snapshot_id, args.ref].map(x => JSON.stringify(x)).join(',') + ')';
    const response = await this.cdp(id, 'Runtime.evaluate', { expression, contextId, returnByValue: false }, deadline);
    if (response.exceptionDetails || !response.result?.objectId) fail('UNVERIFIED_FOCUS', '无法确认富文本焦点。');
    const objectId = response.result.objectId;
    try {
      const described = await this.cdp(id, 'DOM.describeNode', { objectId, depth: 1, pierce: true }, deadline);
      if (!described.node || described.node.nodeType !== 1) fail('UNVERIFIED_FOCUS', '无法验证编辑宿主。');
      if (described.node.shadowRoots?.some(root => root.shadowRootType === 'closed')) fail('UNVERIFIED_FOCUS', '封闭 Shadow DOM 内的真实输入目标无法确认。');
    } finally { await this.cdp(id, 'Runtime.releaseObject', { objectId }, deadline).catch(() => {}); }
  }
  async insertText(id, rootId, args, origin, deadline, guard, progress, value, characters, inFrame) {
    const parts = characters ? Array.from(value) : [value];
    for (const text of parts) {
      await guard();
      const target = await this.evaluate(id, focusedElement, [origin, args.snapshot_id, args.ref], deadline);
      if (!target || target.password || target.input_type === 'file' || target.frame || target.shadow || target.unverified) fail('UNVERIFIED_FOCUS', '实际文本输入目标无法确认。');
      if (inFrame) await this.frames.focus(inFrame, deadline, guard);
      if (target.editable) await this.verifyEditor(id, args, origin, deadline);
      await guard();
      const confirmed = await this.evaluate(id, focusedElement, [origin, args.snapshot_id, args.ref], deadline);
      if (confirmed?.focus_id !== target.focus_id || confirmed?.password || confirmed?.input_type === 'file' || confirmed?.unverified || confirmed?.shadow) fail('FOCUS_CHANGED', '输入焦点已变化。');
      if (confirmed?.editable) await this.verifyEditor(id, args, origin, deadline);
      if (inFrame) await this.frames.focus(inFrame, deadline, guard);
      progress.dispatched = true;
      if (text === '') {
        try { await this.cdp(rootId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, deadline); }
        finally { await this.cdp(rootId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, Math.max(deadline, Date.now() + 1000)); }
      } else await this.cdp(rootId, 'Input.insertText', { text }, deadline);
    }
  }
  checkKeyTarget(target, args, key) {
    if (target?.frame) fail('FOCUS_IN_FRAME', '键盘焦点在内嵌框架中，请用 ref 指定主页面元素。');
    if (target?.editable && !args.ref) fail('UNVERIFIED_FOCUS', '富文本输入需要明确的快照元素引用。');
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
  async pressKey(id, args, origin, deadline, guard, progress, inFrame = null) {
    const key = keyDefinition(args.key);
    if (args.ref) await this.prepare(id, args, origin, 'focus', '', deadline, guard, progress,
      target => this.checkKeyTarget(target, args, key));
    const readTarget = () => this.evaluate(id, focusedElement, [origin, args.snapshot_id || '', args.ref || ''], deadline);
    const target = await readTarget();
    this.checkKeyTarget(target, args, key);
    if (target?.editable) await this.verifyEditor(id, args, origin, deadline);
    if (inFrame) await this.frames.focus(inFrame, deadline, guard);
    await guard();
    // Recheck after the asynchronous permission/lease guard, immediately before input.
    const checked = await readTarget();
    this.checkKeyTarget(checked, args, key);
    if (checked?.editable) await this.verifyEditor(id, args, origin, deadline);
    if (inFrame) await this.frames.focus(inFrame, deadline, guard);
    if (JSON.stringify(checked) !== JSON.stringify(target)) fail('FOCUS_CHANGED', '键盘目标已变化，请重新读取快照；没有发送按键。');
    deadlineCheck(deadline);
    progress.dispatched = true;
    const event = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: key.shift ? 8 : 0 };
    try {
      await this.cdp(typeof id === 'number' ? id : id.tabId, 'Input.dispatchKeyEvent', key.text ? { ...event, type: 'keyDown', text: key.text, unmodifiedText: key.text } : { ...event, type: 'rawKeyDown' }, deadline);
    } finally {
      // Release even when the press reply is lost; never leave a key held down.
      await this.cdp(typeof id === 'number' ? id : id.tabId, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' }, Math.max(deadline, Date.now() + 1000));
    }
    // Page-derived details are returned to the caller but not stored in the write ledger.
    return { details: { pressed: args.key, target: checked } };
  }
}
