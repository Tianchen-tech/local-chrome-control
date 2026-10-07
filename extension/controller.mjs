import { createPolicy, permitsOrigin, checkMethod } from './policy.mjs';
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
    this.reconfiguring = new Set();
    this.revocations = new Map();
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
  async grant(tab, options = {}) {
    await this.ready;
    const origin = webOrigin(tab.url);
    const policy = createPolicy(origin, options, this.now());
    if (!permitsOrigin(policy, origin)) fail('SITE_BLOCKED', '当前网站在黑名单中，不能授权。请先移除对应域名。');
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
      this.grants.set(tab.id, { tabId: tab.id, origin, title: current.title || '', epoch: crypto.randomUUID(), grantedAt: this.now(), lease: null, policy, revision: 0 });
      return await this.list();
    } catch (error) {
      this.grants.delete(tab.id);
      await this.adapter.detach(tab.id).catch(() => {});
      throw error;
    } finally {
      this.pendingGrants.delete(tab.id);
    }
  }
  async reconfigure(tab, options) {
    await this.ready;
    const origin = webOrigin(tab.url), policy = createPolicy(origin, options, this.now());
    const old = this.grants.get(tab.id);
    if (!old || this.pendingGrants.has(tab.id) || this.reconfiguring.has(tab.id)) fail('AUTHORIZATION_CHANGED', '当前授权已变化，请刷新弹窗。');
    if (!permitsOrigin(policy, origin)) {
      await this.revoke(tab.id, 'SITE_BLOCKED');
      return this.list();
    }
    this.reconfiguring.add(tab.id);
    this.grants.delete(tab.id); // Invalidate the old lease before any await.
    this.adapter.forget(tab.id);
    const revision = this.revocations.get(tab.id) || 0;
    try {
      const current = await this.adapter.tab(tab.id);
      if ((this.revocations.get(tab.id) || 0) !== revision) fail('AUTHORIZATION_CHANGED', '授权调整已被停止。');
      if (webOrigin(current.url) !== origin) fail('ORIGIN_CHANGED', '页面已跳转，请重新选择范围。');
      this.grants.set(tab.id, { tabId: tab.id, origin, title: current.title || '', epoch: crypto.randomUUID(), grantedAt: this.now(), lease: null, policy, revision: 0 });
      return await this.list();
    } catch (error) {
      this.grants.delete(tab.id); await this.adapter.detach(tab.id).catch(() => {}); throw error;
    } finally { this.reconfiguring.delete(tab.id); }
  }
  async revoke(tabId, reason = 'USER_STOPPED') {
    this.revocations.set(tabId, (this.revocations.get(tabId) || 0) + 1);
    const grant = this.grants.get(tabId);
    const pending = this.pendingGrants.get(tabId);
    if (pending) pending.cancelled = true;
    this.grants.delete(tabId); // Revoke before awaiting: pending commands see the change.
    this.adapter.forget(tabId);
    if (grant || pending || this.reconfiguring.has(tabId)) await this.adapter.detach(tabId).catch(() => {});
    if (grant) this.record('stop', 0, reason);
  }
  async revokeAll() {
    await Promise.all([...new Set([...this.grants.keys(), ...this.pendingGrants.keys(), ...this.reconfiguring])].map(id => this.revoke(id)));
  }
  async onNavigation(tabId, url) {
    const grant = this.grants.get(tabId) || this.pendingGrants.get(tabId);
    if (!grant) return;
    try {
      const origin = webOrigin(url);
      if (grant.policy && grant.policy.expires_at <= this.now()) await this.revoke(tabId, 'AUTHORIZATION_EXPIRED');
      else if (grant.policy ? !permitsOrigin(grant.policy, origin) : origin !== grant.origin) await this.revoke(tabId, 'ORIGIN_CHANGED');
      else { grant.origin = origin; grant.revision = (grant.revision || 0) + 1; this.adapter.forget(tabId); }
    } catch { await this.revoke(tabId, 'ORIGIN_CHANGED'); }
  }
  async list() {
    const result = [];
    for (const [id, grant] of this.grants) {
      try {
        const tab = await this.adapter.tab(id);
        if (this.grants.get(id) !== grant) continue;
        if (grant.policy.expires_at <= this.now()) { await this.revoke(id, 'AUTHORIZATION_EXPIRED'); continue; }
        const origin = webOrigin(tab.url);
        if (!permitsOrigin(grant.policy, origin)) { await this.revoke(id, 'ORIGIN_CHANGED'); continue; }
        if (origin !== grant.origin) { grant.origin = origin; grant.revision++; this.adapter.forget(id); }
        const lease = grant.lease?.expiresAt > this.now() ? grant.lease : null;
        result.push({ tab_id: id, title: tab.title || '', url: safeUrl(tab.url), origin: grant.origin, mode: grant.policy.mode, scope_kind: grant.policy.scope_kind, blocked_sites: grant.policy.blocked_sites, authorization_minutes: grant.policy.minutes, allowed_origins: grant.policy.origins, frame_origins: grant.policy.frame_origins, authorization_expires_at: grant.policy.expires_at,
          controlled_by: lease?.taskName || null, lease_expires_at: lease?.expiresAt || null });
      } catch { await this.revoke(id, 'TAB_CLOSED'); }
    }
    return result;
  }
  async guard(args, epoch) {
    const grant = this.grants.get(args.tab_id);
    if (!grant) fail('TAB_NOT_AUTHORIZED', '请在扩展弹窗里允许控制这个标签页。');
    if (grant.policy.expires_at <= this.now()) { await this.revoke(args.tab_id, 'AUTHORIZATION_EXPIRED'); fail('AUTHORIZATION_EXPIRED', '授权已到期，请由用户在弹窗重新授权。'); }
    if (epoch && grant.epoch !== epoch) fail('AUTHORIZATION_CHANGED', '标签页授权已改变，请重新获取控制权。');
    const lease = grant.lease;
    if (!lease || lease.id !== args.lease_id || lease.expiresAt <= this.now()) {
      fail('LEASE_EXPIRED', '任务控制权已失效，请重新获取控制权并读取页面。');
    }
    const tab = await this.adapter.tab(args.tab_id);
    if (!this.grants.has(args.tab_id)) fail('TAB_NOT_AUTHORIZED', '这个标签页已停止授权。');
    if (this.grants.get(args.tab_id) !== grant) fail('AUTHORIZATION_CHANGED', '标签页授权已改变，请重新获取控制权。');
    if (grant.lease !== lease || lease.expiresAt <= this.now()) fail('LEASE_EXPIRED', '任务控制权已失效，请重新读取页面。');
    const origin = webOrigin(tab.url);
    if (!permitsOrigin(grant.policy, origin)) {
      await this.revoke(args.tab_id, 'ORIGIN_CHANGED');
      fail('ORIGIN_CHANGED', '页面超出授权网站范围，需要用户重新授权。');
    }
    if (origin !== grant.origin) { grant.origin = origin; grant.revision++; this.adapter.forget(args.tab_id); }
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
      if (grant.policy.expires_at <= this.now()) { await this.revoke(args.tab_id); fail('AUTHORIZATION_EXPIRED', '授权已到期。'); }
      const origin = webOrigin(tab.url);
      if (!permitsOrigin(grant.policy, origin)) { await this.revoke(args.tab_id); fail('ORIGIN_CHANGED', '页面超出授权网站范围。'); }
      if (origin !== grant.origin) { grant.origin = origin; grant.revision++; this.adapter.forget(args.tab_id); }
      grant.lease = { id: crypto.randomUUID(), taskName: args.task_name, expiresAt: this.now() + LEASE_MS };
      return { tab_id: args.tab_id, lease_id: grant.lease.id, expires_at: grant.lease.expiresAt, origin: grant.origin, mode: grant.policy.mode, scope_kind: grant.policy.scope_kind, blocked_sites: grant.policy.blocked_sites, authorization_minutes: grant.policy.minutes, allowed_origins: grant.policy.origins, frame_origins: grant.policy.frame_origins, authorization_expires_at: grant.policy.expires_at };
    }
    const grant = await this.guard(args);
    if (method === 'tab_release') { grant.lease = null; this.adapter.forget(args.tab_id); return { released: true }; }
    checkMethod(grant.policy, method);
    const guard = this.guardFor(args, grant.epoch, deadline, method, grant.revision);
    const result = await this.adapter.run(method, args, grant.origin, deadline, guard, {}, grant.policy);
    await guard(); // A navigation racing a read must not expose another origin's page.
    return result;
  }
  guardFor(args, epoch, deadline, method, revision) {
    return async () => {
      deadlineCheck(deadline); const current = await this.guard(args, epoch);
      checkMethod(current.policy, method);
      if (method !== 'page_navigate' && revision !== undefined && current.revision !== revision) fail('CONTEXT_LOST', '页面已跳转，请重新读取快照。');
      deadlineCheck(deadline); return current;
    };
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
      checkMethod(grant.policy, method);
      if (method === 'page_navigate' && !permitsOrigin(grant.policy, webOrigin(args.url))) {
        fail(grant.policy.mode === 'extended' ? 'SITE_BLOCKED' : 'ORIGIN_NOT_AUTHORIZED', grant.policy.mode === 'extended' ? '目标网站在本次授权的黑名单中，不能跳转或操作。' : '当前模式仅允许同网站跳转。跨站操作请由用户在弹窗选择扩展模式。');
      }
      await this.saveRecord(args.request_id, { fingerprint: hash, epoch: grant.epoch, status: 'pending', at: this.now() });
      record = { fingerprint: hash, epoch: grant.epoch };
      const guard = this.guardFor(args, grant.epoch, deadline, method, grant.revision);
      await guard();
      const result = await this.adapter.run(method, args, grant.origin, deadline, guard, progress, grant.policy);
      await guard();
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
        request_id: args.request_id, cause: error.code || 'BROWSER_ERROR', ...(info.details?.command ? { command: info.details.command } : {})
      });
    }
  }
}
