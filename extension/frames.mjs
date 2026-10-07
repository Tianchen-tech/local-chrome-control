import { snapshotPage, focusedElement, viewportMetrics } from './page-world.mjs';
import { MAX_TEXT, MAX_NODES, fail, webOrigin } from './protocol.mjs';
import { permitsOrigin } from './policy.mjs';

function ownerMetrics(scroll = false) {
  const el = this;
  for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
    const style = getComputedStyle(n);
    if (n.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden') return { visible: false };
    if (style.transform !== 'none') { const matrix = new DOMMatrix(style.transform); if (Math.abs(matrix.b) > 0.001 || Math.abs(matrix.c) > 0.001 || !matrix.is2D) return { visible: true, supported: false }; }
  }
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect(), sx = rect.width / el.offsetWidth, sy = rect.height / el.offsetHeight;
  let active = el.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return { visible: rect.width > 0 && rect.height > 0, supported: true, x: rect.left + el.clientLeft * sx, y: rect.top + el.clientTop * sy,
    width: el.clientWidth * sx, height: el.clientHeight * sy, focused: active === el };
}

// Frame routes are local state, never caller-supplied execution contexts or origins.
export class FrameRouter {
  constructor(adapter) {
    this.adapter = adapter; this.sessions = new Map(); this.routes = new Map(); this.enabled = new Set(); this.pending = new Set();
    adapter.api.debugger.onEvent?.addListener((source, method, params) => {
      if (!this.enabled.has(source.tabId)) return;
      if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
        const target = { tabId: source.tabId, sessionId: params.sessionId };
        this.sessions.set(source.tabId + ':' + params.sessionId, target);
        const ready = this.autoAttach(target).catch(() => {}).finally(() => this.pending.delete(ready));
        this.pending.add(ready);
      } else if (method === 'Target.detachedFromTarget') {
        this.sessions.delete(source.tabId + ':' + params.sessionId); this.forget(source.tabId);
      } else if (['Page.frameNavigated', 'Runtime.executionContextsCleared'].includes(method)) {
        this.adapter.forget(source.tabId);
      }
    });
  }
  async autoAttach(target) {
    await this.adapter.cdp(target, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, Date.now() + 3000);
    await this.adapter.cdp(target, 'Page.enable', {}, Date.now() + 3000);
  }
  async enable(tabId) {
    if (!this.adapter.api.debugger.onEvent) return;
    this.enabled.add(tabId);
    try { await this.autoAttach({ tabId }); }
    catch (error) { this.disable(tabId); throw error; }
  }
  forget(tabId) { this.routes.delete(tabId); }
  disable(tabId) {
    this.enabled.delete(tabId); this.forget(tabId);
    for (const [key, target] of this.sessions) if (target.tabId === tabId) this.sessions.delete(key);
  }
  origin(frame) {
    try {
      if (/^https?:/.test(frame.url)) webOrigin(frame.url); // Preserve restricted-URL checks.
      return webOrigin(frame.securityOrigin || frame.url);
    } catch { return null; }
  }
  async owner(node, trees, deadline, scroll = false) {
    const parent = trees.get(node.parentId);
    if (!parent) fail('FRAME_NOT_READY', '无法定位外层框架。');
    const owner = await this.adapter.cdp(parent.target, 'DOM.getFrameOwner', { frameId: node.frame.id }, deadline);
    const executionContextId = await this.adapter.world(parent.target, deadline);
    const resolved = await this.adapter.cdp(parent.target, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId }, deadline);
    if (!resolved.object?.objectId) fail('FRAME_NOT_READY', '框架宿主尚未就绪。');
    const objectId = resolved.object.objectId;
    try {
      const result = await this.adapter.cdp(parent.target, 'Runtime.callFunctionOn', { objectId, functionDeclaration: ownerMetrics.toString(),
        arguments: [{ value: scroll }], returnByValue: true }, deadline);
      if (result.exceptionDetails) fail('FRAME_NOT_READY', '无法确认框架宿主。');
      return { ...result.result?.value, backend_node_id: owner.backendNodeId };
    } finally { await this.adapter.cdp(parent.target, 'Runtime.releaseObject', { objectId }, deadline).catch(() => {}); }
  }
  async snapshot(tabId, origin, deadline, guard, policy) {
    const a = this.adapter, trees = new Map();
    const walk = (tree, target, parentId = '') => {
      if (!tree?.frame) return;
      const frame = tree.frame;
      const existing = trees.get(frame.id);
      // The child target's own root provides the correct execution-context transport.
      if (!existing || target.sessionId) trees.set(frame.id, { frame, target: { ...target, frameId: frame.id }, parentId: frame.parentId || parentId });
      for (const child of tree.childFrames || []) walk(child, target, frame.id);
    };
    await Promise.all([...this.pending]);
    const root = await a.cdp(tabId, 'Page.getFrameTree', {}, deadline);
    walk(root.frameTree, { tabId });
    for (const target of this.sessions.values()) {
      if (target.tabId !== tabId) continue;
      await guard();
      try { walk((await a.cdp(target, 'Page.getFrameTree', {}, deadline)).frameTree, target); }
      catch (error) { if (error.code === 'TIMEOUT') throw error; }
    }
    const rootId = root.frameTree?.frame?.id;
    if (!rootId) fail('FRAME_NOT_READY', '页面框架尚未就绪，请重新读取。');
    const snapshotId = crypto.randomUUID(), refs = new Map(), allowed = new Map();
    const isAllowed = (node, visited = new Set()) => {
      if (allowed.has(node.frame.id)) return allowed.get(node.frame.id);
      if (visited.has(node.frame.id)) return false;
      visited.add(node.frame.id);
      const parent = trees.get(node.parentId);
      const result = node.frame.id === rootId || Boolean(parent && isAllowed(parent, visited) &&
        permitsOrigin(policy, this.origin(node.frame), true, origin));
      allowed.set(node.frame.id, result); return result;
    };
    const main = await a.evaluate(tabId, snapshotPage, [origin, snapshotId, MAX_TEXT, MAX_NODES], deadline);
    const result = { ...main, focused: await a.evaluate(tabId, focusedElement, [origin], deadline), frames: [] };
    let index = 0;
    for (const node of trees.values()) {
      if (node.frame.id === rootId) continue;
      const frameOrigin = this.origin(node.frame);
      const supported = Boolean(isAllowed(node) && frameOrigin);
      const meta = { frame_id: 'f' + (++index), origin: frameOrigin || '[opaque]', supported, reason: supported ? '' : 'FRAME_ORIGIN_NOT_AUTHORIZED' };
      result.frames.push(meta);
      if (!supported || result.elements.length >= MAX_NODES || result.text.length >= MAX_TEXT || index > 12) {
        if (supported) { meta.supported = false; meta.reason = 'SNAPSHOT_LIMIT'; result.truncated = true; }
        continue;
      }
      await guard();
      try {
        let visible = true;
        for (let ancestor = node; ancestor.frame.id !== rootId; ancestor = trees.get(ancestor.parentId)) {
          if (!ancestor || !(await this.owner(ancestor, trees, deadline))?.visible) { visible = false; break; }
        }
        if (!visible) { meta.supported = false; meta.reason = 'FRAME_HIDDEN'; continue; }
        const shot = await a.evaluate(node.target, snapshotPage, [frameOrigin, snapshotId, MAX_TEXT - result.text.length, MAX_NODES - result.elements.length], deadline);
        for (const element of shot.elements) {
          const ref = meta.frame_id + '_' + element.ref;
          refs.set(ref, { target: node.target, origin: frameOrigin, localRef: element.ref, frame: node, trees, rootId });
          result.elements.push({ ...element, ref, frame: meta.frame_id });
        }
        result.text = (result.text + '\n[iframe ' + meta.frame_id + ']\n' + shot.text).slice(0, MAX_TEXT);
        result.truncated ||= shot.truncated;
      } catch (error) {
        if (error.code === 'TIMEOUT') throw error;
        meta.supported = false; meta.reason = 'FRAME_NOT_READY';
      }
      await guard();
    }
    this.routes.set(tabId, { snapshotId, refs });
    result.limitations = result.frames.some(f => !f.supported) ? ['未授权、尚未就绪或超过快照上限的框架不提供 DOM 内容。'] : [];
    return result;
  }
  route(args, policy, topOrigin) {
    const state = this.routes.get(args.tab_id);
    if (args.ref && this.enabled.has(args.tab_id) && (!state || state.snapshotId !== args.snapshot_id)) fail('STALE_SNAPSHOT', '快照已失效，请重新读取。');
    if (!args.ref?.startsWith('f')) return null;
    if (!state || state.snapshotId !== args.snapshot_id) fail('STALE_SNAPSHOT', '框架快照已失效，请重新读取。');
    const route = state.refs.get(args.ref);
    if (!route) fail('STALE_REF', '框架元素引用不存在。');
    if (!permitsOrigin(policy, route.origin, true, topOrigin)) fail('FRAME_ORIGIN_NOT_AUTHORIZED', '内嵌网站未授权。');
    return route;
  }
  async focus(route, deadline, guard) {
    for (let node = route.frame; node.frame.id !== route.rootId; node = route.trees.get(node.parentId)) {
      await guard();
      if (!(await this.owner(node, route.trees, deadline))?.focused) fail('FOCUS_CHANGED', '内嵌框架已失去实际键盘焦点。');
    }
  }
  async point(route, point, deadline, guard) {
    const a = this.adapter; let node = route.frame, mapped = { ...point }, boundary = null;
    while (node.frame.id !== route.rootId) {
      const parent = route.trees.get(node.parentId);
      if (!parent) fail('FRAME_NOT_READY', '无法定位外层框架。');
      await guard();
      const box = await this.owner(node, route.trees, deadline);
      if (!box?.visible) fail('ELEMENT_HIDDEN', '内嵌框架不可见。');
      if (!box.supported) fail('UNSUPPORTED_FRAME_GEOMETRY', '旋转或不规则框架暂不支持输入。');
      if (node.target.sessionId !== parent.target.sessionId) boundary = { parent_frame_id: parent.frame.id, backend_node_id: box.backend_node_id };
      const view = await a.evaluate(node.target, viewportMetrics, [this.origin(node.frame)], deadline);
      mapped = { x: box.x + mapped.x * box.width / view.width, y: box.y + mapped.y * box.height / view.height };
      node = parent;
    }
    const view = await a.evaluate(route.target.tabId, viewportMetrics, [this.origin(node.frame)], deadline);
    if (mapped.x < 0 || mapped.y < 0 || mapped.x >= view.width || mapped.y >= view.height) fail('FRAME_OUTSIDE_VIEWPORT', '请先滚动外层页面，使框架显示在视口内。');
    // DOM hit testing uses document coordinates; trusted input uses viewport
    // coordinates. Scrolling the outer document must not move the hit check to
    // a different iframe (or a point with no node).
    const hit = await a.cdp(route.target.tabId, 'DOM.getNodeForLocation', { x: Math.round(mapped.x + (view.x || 0)), y: Math.round(mapped.y + (view.y || 0)), includeUserAgentShadowDOM: true }, deadline);
    // Root hit-testing stops at the host of an out-of-process iframe. Match
    // its exact backend node and parent frame, never accept the whole parent.
    // prepareAction has already hit-tested the actual ref inside the child.
    const hostHit = boundary && Number.isSafeInteger(boundary.backend_node_id) &&
      hit.frameId === boundary.parent_frame_id && hit.backendNodeId === boundary.backend_node_id;
    if (hit.frameId !== route.frame.frame.id && !hostHit) fail('ELEMENT_OBSCURED', '内嵌框架被其他元素遮挡。');
    return mapped;
  }
}
