import { LEASE_MS, LEDGER_RETENTION_MS, LEDGER_LIMIT, MUTATIONS, VERSION, fail, validate, webOrigin, safeUrl, fingerprint, errorObject, deadlineCheck } from './protocol.mjs';

// Browser access is injected, so state and failure recovery can be tested without touching a real profile.
export class Controller {
  constructor(adapter, storage, now = () => Date.now()) {
    this.adapter = adapter;
    this.storage = storage;
    this.now = now;
    this.grants = new Map();
    this.pendingGrants = new Map();
    this.locks = new Map();
    this.ledger = {};
    this.recent = [];
    this.ready = this.restore();
  }
  async restore() {
    this.ledger = Object.assign(Object.create(null), await this.storage.loadLedger());
    // An interrupted pending action is ambiguous. Never dispatch it again.
    for (const entry of Object.values(this.ledger)) {
      if (entry.status === 'pending') entry.status = 'unknown';
    }
    await this.storage.saveLedger(this.ledger);
    // User grants intentionally do not survive a worker restart: fail closed. Drop the
    // debugger sessions they left behind so Chrome stops showing a debugging banner.
    try { await this.adapter.detachOrphans?.(); } catch {}
  }
  async grant(tab) {
    await this.ready;
    const origin = webOrigin(tab.url);
    if (this.grants.has(tab.id)) return this.list();
    if (this.pendingGrants.has(tab.id)) fail('GRANT_IN_PROGRESS', '正在处理此标签页的授权，请稍后再试。');
    const pending = { origin, cancelled: false };
    this.pendingGrants.set(tab.id, pending);
    try {
      await this.adapter.attach(tab.id);
      if (pending.cancelled) fail('AUTHORIZATION_CHANGED', '授权已停止，请重新点击授权。');
      const current = await this.adapter.tab(tab.id);
      if (pending.cancelled) fail('AUTHORIZATION_CHANGED', '授权已停止，请重新点击授权。');
      if (webOrigin(current.url) !== origin) fail('ORIGIN_CHANGED', '页面已跳转，请在新页面重新授权。');
      this.grants.set(tab.id, { tabId: tab.id, origin, title: current.title || '', epoch: crypto.randomUUID(), grantedAt: this.now(), lease: null });
      return await this.list();
    } catch (error) {
      this.grants.delete(tab.id);
      await this.adapter.detach(tab.id).catch(() => {});
      throw error;
    } finally {
      this.pendingGrants.delete(tab.id);
    }
  }
  async revoke(tabId, reason = 'USER_STOPPED') {
    const grant = this.grants.get(tabId);
    const pending = this.pendingGrants.get(tabId);
    if (pending) pending.cancelled = true;
    this.grants.delete(tabId); // Revoke before awaiting: pending commands see the change.
    this.adapter.forget(tabId);
    if (grant || pending) await this.adapter.detach(tabId).catch(() => {});
    if (grant) this.record('stop', 0, reason);
  }
  async revokeAll() {
    await Promise.all([...new Set([...this.grants.keys(), ...this.pendingGrants.keys()])].map(id => this.revoke(id)));
  }
  async onNavigation(tabId, url) {
    const grant = this.grants.get(tabId) || this.pendingGrants.get(tabId);
    if (!grant) return;
    try {
      if (webOrigin(url) !== grant.origin) await this.revoke(tabId, 'ORIGIN_CHANGED');
      else this.adapter.forget(tabId);
    } catch { await this.revoke(tabId, 'ORIGIN_CHANGED'); }
  }
  async list() {
    const result = [];
    for (const [id, grant] of this.grants) {
      try {
        const tab = await this.adapter.tab(id);
        if (this.grants.get(id) !== grant) continue;
        if (webOrigin(tab.url) !== grant.origin) { await this.revoke(id, 'ORIGIN_CHANGED'); continue; }
        const lease = grant.lease?.expiresAt > this.now() ? grant.lease : null;
        result.push({ tab_id: id, title: tab.title || '', url: safeUrl(tab.url), origin: grant.origin,
          controlled_by: lease?.taskName || null, lease_expires_at: lease?.expiresAt || null });
      } catch { await this.revoke(id, 'TAB_CLOSED'); }
    }
    return result;
  }
  async guard(args, epoch) {
    const grant = this.grants.get(args.tab_id);
    if (!grant) fail('TAB_NOT_AUTHORIZED', '请在扩展弹窗里允许控制这个标签页。');
    if (epoch && grant.epoch !== epoch) fail('AUTHORIZATION_CHANGED', '标签页授权已改变，请重新获取控制权。');
    const lease = grant.lease;
    if (!lease || lease.id !== args.lease_id || lease.expiresAt <= this.now()) {
      fail('LEASE_EXPIRED', '任务控制权已失效，请重新获取控制权并读取页面。');
    }
    const tab = await this.adapter.tab(args.tab_id);
    if (!this.grants.has(args.tab_id)) fail('TAB_NOT_AUTHORIZED', '这个标签页已停止授权。');
    if (this.grants.get(args.tab_id) !== grant) fail('AUTHORIZATION_CHANGED', '标签页授权已改变，请重新获取控制权。');
    if (grant.lease !== lease || lease.expiresAt <= this.now()) fail('LEASE_EXPIRED', '任务控制权已失效，请重新读取页面。');
    if (webOrigin(tab.url) !== grant.origin) {
      await this.revoke(args.tab_id, 'ORIGIN_CHANGED');
      fail('ORIGIN_CHANGED', '页面已切换网站，需要重新授权。');
    }
    grant.lease.expiresAt = this.now() + LEASE_MS;
    return grant;
  }
  record(method, elapsedMs, code = 'OK') {
    this.recent.unshift({ method, elapsed_ms: elapsedMs, code, at: this.now() });
    this.recent.length = Math.min(this.recent.length, 20);
  }
  async saveRecord(id, entry) {
    // A record can only be replayed with its lease, and leases die with their grant. Keep
    // records of live grants regardless of age; others only need to serve request_status.
    const cutoff = this.now() - LEDGER_RETENTION_MS;
    const live = new Set([...this.grants.values()].map(grant => grant.epoch));
    for (const [key, value] of Object.entries(this.ledger)) {
      if (value.at < cutoff && !live.has(value.epoch)) delete this.ledger[key];
    }
    // Fail closed when full: silently evicting recent IDs would allow duplicate submissions.
    if (!this.ledger[id] && Object.keys(this.ledger).length >= LEDGER_LIMIT) {
      fail('LEDGER_FULL', '近期操作记录已达上限，请稍后再试。记录不会提前删除以避免重复提交。');
    }
    this.ledger[id] = entry;
    await this.storage.saveLedger(this.ledger);
  }
  async execute(method, args = {}, deadline = Date.now() + 8000) {
    await this.ready;
    validate(method, args);
    const started = this.now();
    const run = () => this.run(method, args, deadline);
    const previous = this.locks.get(args.tab_id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(run);
    if (args.tab_id !== undefined) this.locks.set(args.tab_id, pending);
    try {
      const result = await pending;
      this.record(method, this.now() - started);
      return { ...result, elapsed_ms: this.now() - started };
    } catch (error) {
      this.record(method, this.now() - started, error.code || 'INTERNAL_ERROR');
      throw error;
    } finally {
      if (this.locks.get(args.tab_id) === pending) this.locks.delete(args.tab_id);
    }
  }
  async run(method, args, deadline) {
    if (MUTATIONS.has(method)) return this.mutate(method, args, deadline);
    deadlineCheck(deadline);
    if (method === 'status') return { version: VERSION, authorized_tabs: this.grants.size, recent: this.recent };
    if (method === 'tabs_list') return { tabs: await this.list() };
    if (method === 'request_status') {
      const entry = this.ledger[args.request_id];
      return entry ? { request_id: args.request_id, status: entry.status, at: entry.at, outcome: entry.outcome } :
        { request_id: args.request_id, status: 'not_found', note: '未找到记录不代表可以重试；请先核对页面。' };
    }
    if (method === 'tab_claim') {
      const grant = this.grants.get(args.tab_id);
      if (!grant) fail('TAB_NOT_AUTHORIZED', '请先在 Chrome 扩展里允许控制这个标签页。');
      if (grant.lease?.expiresAt > this.now()) fail('TAB_BUSY', '这个标签页正在由另一个任务控制。', { task_name: grant.lease.taskName });
      const tab = await this.adapter.tab(args.tab_id);
      if (!this.grants.has(args.tab_id)) fail('TAB_NOT_AUTHORIZED', '这个标签页已停止授权。');
      if (this.grants.get(args.tab_id) !== grant) fail('AUTHORIZATION_CHANGED', '标签页授权已改变，请重新获取控制权。');
      if (webOrigin(tab.url) !== grant.origin) {
        await this.revoke(args.tab_id);
        fail('ORIGIN_CHANGED', '页面已切换网站，需要重新授权。');
      }
      grant.lease = { id: crypto.randomUUID(), taskName: args.task_name, expiresAt: this.now() + LEASE_MS };
      return { tab_id: args.tab_id, lease_id: grant.lease.id, expires_at: grant.lease.expiresAt, origin: grant.origin };
    }
    const grant = await this.guard(args);
    if (method === 'tab_release') { grant.lease = null; this.adapter.forget(args.tab_id); return { released: true }; }
    const guard = this.guardFor(args, grant.epoch, deadline);
    const result = await this.adapter.run(method, args, grant.origin, deadline, guard);
    await guard(); // A navigation racing a read must not expose another origin's page.
    return result;
  }
  guardFor(args, epoch, deadline) {
    return async () => { deadlineCheck(deadline); const current = await this.guard(args, epoch); deadlineCheck(deadline); return current; };
  }
  async mutate(method, args, deadline) {
    // Resolve duplicates before checking an expired lease: querying an earlier result is safe.
    const hash = await fingerprint(method, args);
    const existing = this.ledger[args.request_id];
    if (existing) {
      if (existing.fingerprint !== hash) fail('REQUEST_ID_CONFLICT', '这个 request_id 已用于不同操作，拒绝执行。');
      if (existing.status === 'done') return { ...existing.outcome, replayed: true };
      // A recorded failure never reached the page, so the same request may run again.
      if (existing.status !== 'failed') {
        fail('ACTION_STATUS_UNKNOWN', '先前操作可能已经执行，禁止自动重试；请核对页面结果。', { request_id: args.request_id, status: existing.status });
      }
    }
    // Includes scrolling/focusing preparation: those can trigger page-owned handlers.
    const progress = { dispatched: false };
    let record = null;
    try {
      deadlineCheck(deadline);
      const grant = await this.guard(args);
      if (method === 'page_navigate' && webOrigin(args.url) !== grant.origin) {
        fail('ORIGIN_NOT_AUTHORIZED', '仅允许在已授权网站内跳转。请手动打开新网站，再在扩展里授权。');
      }
      await this.saveRecord(args.request_id, { fingerprint: hash, epoch: grant.epoch, status: 'pending', at: this.now() });
      record = { fingerprint: hash, epoch: grant.epoch };
      const guard = this.guardFor(args, grant.epoch, deadline);
      await guard();
      const result = await this.adapter.run(method, args, grant.origin, deadline, guard, progress);
      const outcome = { request_id: args.request_id, status: 'done', note: '已执行操作；请读取新快照确认网页结果。' };
      await this.saveRecord(args.request_id, { ...record, status: 'done', at: this.now(), outcome });
      return { ...outcome, ...result?.details };
    } catch (error) {
      const info = errorObject(error);
      if (!progress.dispatched) {
        // Rejected by a precondition: nothing reached the page, so report the real cause.
        if (record) await this.saveRecord(args.request_id, { ...record, status: 'failed', at: this.now(), outcome: { error: info } });
        fail(info.code, info.message, { ...info.details, request_id: args.request_id, executed: false });
      }
      await this.saveRecord(args.request_id, { ...record, status: 'unknown', at: this.now(), outcome: { error: info } });
      fail('ACTION_STATUS_UNKNOWN', '准备动作或网页操作可能已生效，但未得到完整确认。请先核对页面，不能自动重复执行。', {
        request_id: args.request_id, cause: error.code || 'BROWSER_ERROR'
      });
    }
  }
}
