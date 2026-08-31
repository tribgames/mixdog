import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { hiddenSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import { withHeapCap } from '../runtime/shared/heap-cap.mjs';
import {
  acquire as acquireMachineSpawnSlot,
  snapshot as machineSpawnSnapshot,
} from '../runtime/shared/child-spawn-gate.mjs';
import { createRuntimeLagTracker } from '../runtime/shared/session-runtime-health.mjs';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from './session-protocol.mjs';
import {
  createShardOwnership,
  mergeProviderCooldown,
  normalizeShardCount,
  resolveShardCount,
  runtimeRoutingKey,
  selectShardIndex,
} from './session-runtime-shard-router.mjs';
import { applySessionStatePatch } from './session-state-patch.mjs';
import { renderResult as renderAgentResult } from './agent-tool/render.mjs';

const RUNTIME_METHODS = new Set([
  ...SESSION_READ_ACTIONS,
  ...SESSION_CONFIGURE_ACTIONS,
  'readModelMessages',
  'reserveSession',
  'resume',
  'submitAsync',
  'submitAndWait',
  'abort',
  'closeCanonicalSession',
  'resolveToolApproval',
  'dispose',
]);

export function applyRuntimeStateFrame(previous, frame) {
  if (frame?.full && typeof frame.full === 'object') return frame.full;
  const patch = frame?.patch;
  if (!patch || typeof patch !== 'object') return previous || {};
  return applySessionStatePatch(previous, patch);
}

/**
 * One runtime child process = one shard = one event-loop failure domain.
 *
 * Everything below (identity, revisions, recovery, recycling, spawn leases)
 * is scoped to THIS child, so a saturated or crashed shard can never freeze
 * control/abort for sessions owned by a sibling shard.
 */
class SessionRuntimeShard {
  constructor({ index = 0, pool = null, workerEntry, cwd, env, log, onAgentSessionState }) {
    this.index = Math.max(0, Math.floor(Number(index) || 0));
    this.pool = pool;
    this.workerEntry = workerEntry;
    this.cwd = cwd;
    this.env = env;
    const emit = typeof log === 'function' ? log : () => {};
    this.log = (line) => emit(`session runtime shard ${this.index} ${line}`);
    this.lag = createRuntimeLagTracker();
    this.onAgentSessionState = onAgentSessionState;
    this.child = null;
    this.pending = new Map();
    this.proxies = new Map();
    this.sequence = 0;
    this.closed = false;
    this.recovery = null;
    this.recycling = null;
    this.prewarmChildRef = null;
    this.prewarmPromise = null;
    this.failedChildren = new WeakSet();
    // Machine-wide spawn leases held on behalf of the runtime child process.
    this.spawnLeases = new Map(); // leaseId -> { release, controller, settled }
  }

  ensureChild() {
    if (this.child && !this.child.killed) return this.child;
    if (this.closed) throw new Error('session runtime worker is closed');
    const child = fork(this.workerEntry, [], {
      cwd: this.cwd,
      execArgv: withHeapCap('session-runtime'),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...this.env },
      ...hiddenSpawnOpts,
    });
    this.child = child;
    // Lag history belongs to the process that produced it.
    this.lag.reset();
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) this.log(`stderr: ${text}`);
    });
    child.on('message', (message) => this.onMessage(message, child));
    child.on('error', (error) => this.handleChildFailure(child, error));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.handleChildFailure(
        child,
        new Error(`session runtime worker exited (${signal || code || 'unknown'})`),
      );
    });
    // Account-wide provider cooldown and prewarm state are pool facts, not
    // child facts: a freshly forked shard inherits both immediately.
    this.pool?.primeChild(this);
    return child;
  }

  onMessage(message, child = this.child) {
    if (!message || typeof message !== 'object') return;
    // A superseded child (recycled, crashed, or replaced) can still flush
    // queued frames after its replacement is live. Its late state/response must
    // never outrank the replacement's revision or settle its pending calls.
    if (child !== this.child) return;
    if (message.type === 'spawn-lease') {
      void this.grantSpawnLease(message);
      return;
    }
    if (message.type === 'spawn-release') {
      this.settleSpawnLease(String(message.leaseId || ''));
      return;
    }
    if (message.type === 'event-loop-lag') {
      this.recordLag(message.sample);
      return;
    }
    if (message.type === 'provider-cooldown') {
      this.pool?.recordProviderCooldown(this, message);
      return;
    }
    if (message.type === 'agent-control') {
      void this.pool?.handleAgentControl(this, child, message);
      return;
    }
    if (message.type === 'agent-control-cancel') {
      this.pool?.cancelAgentControl(message);
      return;
    }
    if (message.type === 'agent-control-notification') {
      this.pool?.routeAgentControlNotification(message);
      return;
    }
    if (message.type === 'unhealthy') {
      this.recycleUnhealthy(child, message.detail);
      return;
    }
    if (message.type === 'state') {
      this.proxies.get(String(message.runtimeId || ''))?.applyFrame(message);
      return;
    }
    if (message.type === 'turn-timing') {
      const row = message.row && typeof message.row === 'object' ? message.row : {};
      const ms = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : -1;
      this.log(
        `turn timing status=${row.status || 'unknown'} session=${row.sessionId || '-'}`
        + ` e2e=${ms(row.endToEndTtftMs)}ms runtime=${ms(row.ttftMs)}ms`
        + ` queue=${ms(row.queueMs)}ms route=${ms(row.routeMs)}ms`
        + ` preflight=${ms(row.preflightMs)}ms mcp=${ms(row.mcpMs)}ms`
        + ` provider=${ms(row.providerMs)}ms`,
      );
      return;
    }
    if (message.type !== 'response') return;
    const request = this.pending.get(String(message.requestId || ''));
    if (!request) return;
    this.pending.delete(request.id);
    if (request.timer) clearTimeout(request.timer);
    if (message.ok === false) {
      const error = new Error(String(message.error?.message || 'session runtime call failed'));
      if (message.error?.name) error.name = String(message.error.name);
      if (message.error?.stack) error.stack = String(message.error.stack);
      if (message.error?.statusCode) error.statusCode = Number(message.error.statusCode);
      request.reject(error);
    } else {
      request.resolve(message.value);
    }
  }

  rejectPending(error) {
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  handleChildFailure(child, error) {
    if (this.failedChildren.has(child)) return;
    this.failedChildren.add(child);
    // Same identity rule for failures: a retired child's late exit/error must
    // not reject the replacement's in-flight calls or start a second recovery.
    if (this.child && this.child !== child) {
      this.log(`superseded child failed (ignored): ${error?.message || error}`);
      return;
    }
    if (this.child === child) this.child = null;
    // A dead child cannot spawn: its machine-budget slots return immediately.
    this.releaseAllSpawnLeases();
    this.rejectPending(error);
    if (this.closed || this.proxies.size === 0) {
      for (const proxy of this.proxies.values()) proxy.fail(error);
      return;
    }
    for (const proxy of this.proxies.values()) proxy.beginRecovery(error);
    this.recovery ||= this.recover().finally(() => { this.recovery = null; });
  }

  async recover() {
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !this.closed; attempt += 1) {
      try {
        this.ensureChild();
        for (const proxy of this.proxies.values()) await proxy.recreate();
        this.log(`recovered ${this.proxies.size} runtime(s)`);
        return true;
      } catch (error) {
        lastError = error;
        const child = this.child;
        this.child = null;
        try { child?.kill?.(); } catch {}
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
    const error = lastError || new Error('session runtime worker recovery failed');
    for (const proxy of this.proxies.values()) proxy.fail(error);
    return false;
  }

  recycleChild(child, reason) {
    if (this.closed || child !== this.child || this.recycling) return;
    this.log(`recycling pid=${child.pid || 'unknown'}: ${reason}`);
    this.recycling = this.stopChild(reason)
      .then(() => true)
      .catch((error) => {
        this.log(`recycle failed: ${error?.message || error}`);
        try { child.kill?.(); } catch {}
        return false;
      })
      .finally(() => { this.recycling = null; });
    return this.recycling;
  }

  recycleUnhealthy(child, detail = null) {
    const reason = String(detail?.reason || 'session runtime worker reported unhealthy');
    void this.recycleChild(child, `unhealthy: ${reason}`);
  }

  requestRaw(type, payload = {}, timeoutMs = 10 * 60_000) {
    const child = this.ensureChild();
    const requestId = `runtime-${process.pid}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const request = { id: requestId, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        request.timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          reject(new Error(`session runtime worker ${type} timed out`));
        }, timeoutMs);
        request.timer.unref?.();
      }
      this.pending.set(requestId, request);
      if (!safeIpcSend(child, { type, requestId, ...payload }, {
        onError: (error) => {
          if (!this.pending.delete(requestId)) return;
          if (request.timer) clearTimeout(request.timer);
          reject(error);
        },
      })) {
        this.pending.delete(requestId);
        if (request.timer) clearTimeout(request.timer);
        reject(new Error('session runtime worker IPC is unavailable'));
      }
    });
  }

  async request(type, payload = {}, timeoutMs = 10 * 60_000) {
    if (this.recycling) await this.recycling.catch(() => {});
    if (this.recovery) await this.recovery;
    return this.requestRaw(type, payload, timeoutMs);
  }

  async create(runtimeId, options, routingKey = '') {
    const proxy = new SessionRuntimeProxy(runtimeId, this, options, routingKey);
    this.proxies.set(runtimeId, proxy);
    try {
      await this.request('create', { runtimeId, options }, 120_000);
      return proxy;
    } catch (error) {
      // Drop the proxy only. The ownership claim belongs to whoever CLAIMED it
      // (the pool's create path) and is released there exactly once: releasing
      // it here too would decrement a claim still held by another live view of
      // the same session and split that session across two shards after a
      // later quarantine.
      this.proxies.delete(runtimeId);
      throw error;
    }
  }

  /** Drop a runtime AND its shard ownership claim in one place. */
  releaseProxy(runtimeId) {
    const id = String(runtimeId || '');
    const proxy = this.proxies.get(id);
    if (!proxy) return;
    this.proxies.delete(id);
    if (proxy.ownershipReleased) return;
    proxy.ownershipReleased = true;
    this.pool?.releaseOwnership(proxy.routingKey);
  }

  /** Event-loop lag is a routing signal, never a kill signal: a saturated
   *  shard still owns accepted input and in-flight turns. */
  recordLag(sample) {
    const row = sample && typeof sample === 'object' ? sample : null;
    const result = this.lag.record(row);
    const detail = `p95=${row?.p95Ms ?? -1}ms p99=${row?.p99Ms ?? -1}ms max=${row?.maxMs ?? -1}ms`
      + ` runtimes=${this.proxies.size}`;
    if (result.changed) {
      this.log(result.degraded
        ? `event-loop saturated ${detail} — quarantined from new placement`
        : `event-loop lag recovered ${detail} — placement resumed`);
    } else if (Number(row?.p99Ms) >= Number(this.lag.config.warnP99Ms)) {
      this.log(`event-loop lag ${detail}`);
    }
    return result;
  }

  /** Prewarm is per CHILD and issued exactly once for it: the spawn path and
   *  an explicit host prewarm share the same in-flight promise instead of
   *  racing two module-preload passes into one fresh process. */
  prewarmChild() {
    const child = this.ensureChild();
    if (this.prewarmChildRef === child && this.prewarmPromise) return this.prewarmPromise;
    this.prewarmChildRef = child;
    this.prewarmPromise = this.requestRaw('prewarm', {}, 120_000);
    return this.prewarmPromise;
  }

  sendProviderCooldown(cooldown, admission = null) {
    const child = this.child;
    if (!child || child.killed || this.closed) return false;
    return safeIpcSend(child, {
      type: 'provider-cooldown-sync',
      cooldown,
      ...(admission ? { admission } : {}),
    }, { onError: () => {} });
  }

  sendAgentControlNotification(message) {
    const child = this.child;
    if (!child || child.killed || this.closed) return false;
    return safeIpcSend(child, {
      type: 'agent-control-notification',
      ownerSessionId: String(message?.ownerSessionId || ''),
      text: String(message?.text || ''),
      meta: message?.meta && typeof message.meta === 'object' ? message.meta : {},
    }, { onError: () => {} });
  }

  async workloadSnapshot() {
    const base = {
      shard: this.index,
      pid: this.child?.pid || null,
      degraded: this.lag.degraded,
      eventLoopLag: this.lag.sample,
    };
    try {
      const value = await this.request('workload', {}, 2_000);
      return { ...base, pid: this.child?.pid || base.pid, ...value };
    } catch (error) {
      return { ...base, error: String(error?.message || error) };
    }
  }

  get isLive() {
    return Boolean(this.child) && !this.child.killed;
  }

  get degraded() {
    return this.lag.degraded;
  }

  /** Grant one machine-wide spawn lease from the daemon-side gate (the single
   *  budget authority; daemon-hosted work uses the same instance locally). */
  async grantSpawnLease(message) {
    const leaseId = String(message.leaseId || '');
    if (!leaseId || this.spawnLeases.has(leaseId)) return;
    const child = this.child;
    const controller = new AbortController();
    const record = { release: null, controller, settled: false };
    this.spawnLeases.set(leaseId, record);
    const reply = (body) => {
      if (this.child !== child || !child || child.killed) return false;
      return safeIpcSend(child, { type: 'spawn-lease-result', leaseId, ...body }, { onError: () => {} });
    };
    try {
      const release = await acquireMachineSpawnSlot(controller.signal, message.lane, {
        ownerKey: `runtime:${String(message.ownerKey || 'anonymous')}`,
        waitTimeoutMs: Number(message.waitTimeoutMs) > 0 ? Number(message.waitTimeoutMs) : undefined,
      });
      if (record.settled || this.closed || this.child !== child) {
        release();
        this.spawnLeases.delete(leaseId);
        return;
      }
      record.release = release;
      if (!reply({ ok: true })) this.settleSpawnLease(leaseId);
    } catch (error) {
      this.spawnLeases.delete(leaseId);
      if (!record.settled) {
        reply({
          ok: false,
          error: String(error?.message || error),
          code: error?.code || null,
          statusCode: Number(error?.statusCode) || null,
        });
      }
    }
  }

  settleSpawnLease(leaseId) {
    const record = this.spawnLeases.get(leaseId);
    if (!record || record.settled) return;
    record.settled = true;
    if (record.release) {
      try { record.release(); } catch { /* idempotent */ }
      this.spawnLeases.delete(leaseId);
      return;
    }
    // Still queued on the machine gate: cancel the waiter; grantSpawnLease's
    // catch path removes the record.
    record.controller.abort(new Error('spawn lease released while queued'));
  }

  releaseAllSpawnLeases() {
    for (const leaseId of [...this.spawnLeases.keys()]) this.settleSpawnLease(leaseId);
  }

  async close(reason) {
    this.closed = true;
    this.releaseAllSpawnLeases();
    const child = this.child;
    if (!child) return;
    await this.stopChild(reason);
  }

  async stopChild(reason) {
    const child = this.child;
    if (!child) return;
    let exited = false;
    const exitPromise = new Promise((resolve) => {
      child.once('exit', () => {
        exited = true;
        resolve();
      });
    });
    try { await this.requestRaw('shutdown', { reason }, 8_000); } catch {}
    try { child.disconnect?.(); } catch {}
    // The child drains its accepted-input writes before exiting; a hard kill
    // inside that window is exactly what loses them.
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!exited) {
      try { child.kill?.(); } catch {}
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (this.child === child) this.child = null;
  }

  get status() {
    return {
      index: this.index,
      pid: this.child?.pid || null,
      runtimes: this.proxies.size,
      pending: this.pending.size,
      recycling: Boolean(this.recycling),
      degraded: this.lag.degraded,
      lag: this.lag.sample,
    };
  }
}

// Fields whose machine-wide value is the WORST shard rather than the sum:
// configured caps do not add up across processes, and wait/age gauges are
// worst-case signals. Everything else (inflight, queued, counters, bytes) is
// real per-process load and sums.
const WORKLOAD_MAX_FIELDS = new Set([
  'limit', 'maxInflight', 'queueMax', 'activeMax', 'waitTimeoutMs', 'concurrency',
  'maxAgents', 'maxShells', 'maxHighLoad', 'maxQueue', 'minFreeMemoryMb', 'maxRssMb',
  'oldestWaitMs', 'oldestQueuedMs', 'maxWaitMs', 'averageWaitMs', 'ageMs',
  'freeMemoryBytes', 'totalMemoryBytes',
  'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs', 'intervalMs', 'at',
]);
const WORKLOAD_LIST_CAP = 64;

/** Structural merge of two shard workload rows (exported for tests). */
export function mergeShardWorkloadValues(left, right, key = '') {
  if (right === undefined || right === null) return left;
  if (left === undefined || left === null) return right;
  if (typeof left === 'number' && typeof right === 'number') {
    return WORKLOAD_MAX_FIELDS.has(key) ? Math.max(left, right) : left + right;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Boolean(left) || Boolean(right);
  }
  if (typeof left === 'string' || typeof right === 'string') {
    return left === right ? left : 'mixed';
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const entries = [...left, ...right];
    const named = entries.length > 0
      && entries.every((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string');
    if (!named) return entries.slice(0, WORKLOAD_LIST_CAP);
    // Lane/gate rows are per-process views of ONE machine-wide lane: merge by
    // name so `childSpawns.lanes[].inflight` reports the machine total.
    const byName = new Map();
    for (const entry of entries) {
      const existing = byName.get(entry.name);
      byName.set(entry.name, existing ? mergeShardWorkloadValues(existing, entry) : entry);
    }
    return [...byName.values()];
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const out = {};
    for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
      out[field] = mergeShardWorkloadValues(left[field], right[field], field);
    }
    return out;
  }
  return left;
}

/** Aggregate EVERY live shard into the single-worker shape older status
 *  consumers still read (resources/toolIo/childSpawns included), keeping the
 *  per-shard rows alongside it. */
export function aggregateShardWorkload(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length === 0) return null;
  let merged = {};
  for (const row of list) merged = mergeShardWorkloadValues(merged, row);
  const errors = list
    .filter((row) => row?.error)
    .map((row) => `shard ${row.shard ?? '?'}: ${row.error}`);
  const worstLag = list.reduce((worst, row) => {
    const sample = row?.eventLoopLag;
    if (!sample) return worst;
    return !worst || (Number(sample.p99Ms) || 0) > (Number(worst.p99Ms) || 0) ? sample : worst;
  }, null);
  return {
    ...merged,
    // Identity/telemetry fields describe shards individually — never summed.
    shard: list[0]?.shard ?? 0,
    pid: list.find((row) => row?.pid)?.pid ?? null,
    pids: list.map((row) => row?.pid ?? null),
    shards: list.length,
    degraded: list.some((row) => row?.degraded === true),
    eventLoopLag: worstLag,
    ...(errors.length > 0 ? { error: errors[0], errors } : {}),
  };
}

// Wire contract for runtime calls: the fork IPC link serializes frames
// as JSON, which cannot represent `undefined` and would fabricate `null` in
// its place — turning an omitted optional argument (e.g. `resume(id)`) into a
// bogus `resume(id, null)` that bypasses callee default parameters. Trim
// trailing `undefined` arguments before transport so an omitted argument stays
// omitted on the wire and worker-side defaults apply exactly as in-process.
// Interior `undefined` holes cannot be omitted positionally and keep their
// pre-existing JSON behavior.
function wireCallArgs(args) {
  const out = Array.isArray(args) ? [...args] : [];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

class SessionRuntimeProxy {
  constructor(id, shard, options, routingKey = '') {
    this.id = id;
    this.shard = shard;
    // Stable ownership key (sessionId when known): recovery, resume and every
    // later view of this session resolve to the same shard. The claim is
    // released exactly once, by whichever settle path runs first.
    this.routingKey = String(routingKey || id);
    this.ownershipReleased = false;
    this.options = { ...(options || {}) };
    this.state = {};
    this.revision = 0;
    this.listeners = new Set();
    this.failure = null;
    this.recovering = false;
    this.isWireSafe = true;
    for (const method of RUNTIME_METHODS) {
      this[method] = (...args) => this.call(method, args);
    }
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyFrame(frame) {
    const revision = Number(frame.revision) || 0;
    if (revision <= this.revision) return;
    if (frame.patch && revision !== this.revision + 1) {
      void this.shard.request('snapshot', { runtimeId: this.id }, 5_000).catch(() => {});
      return;
    }
    this.state = applyRuntimeStateFrame(this.state, frame);
    this.revision = revision;
    this.failure = null;
    this.recovering = false;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch {}
    }
  }

  fail(error) {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.recovering = false;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch {}
    }
  }

  beginRecovery(error) {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.recovering = true;
  }

  async recreate() {
    const previousSessionId = String(this.state?.sessionId || this.options.sessionId || '');
    this.revision = 0;
    await this.shard.requestRaw('create', {
      runtimeId: this.id,
      options: this.options,
    }, 120_000);
    if (previousSessionId) {
      const resumed = await this.shard.requestRaw('call', {
        runtimeId: this.id,
        method: 'resume',
        args: [previousSessionId],
      }, 120_000);
      if (resumed !== true) {
        await this.shard.requestRaw('call', {
          runtimeId: this.id,
          method: 'reserveSession',
          args: [previousSessionId],
        }, 30_000);
      }
    }
    await this.shard.requestRaw('snapshot', { runtimeId: this.id }, 5_000);
    this.failure = null;
    this.recovering = false;
  }

  async call(method, args) {
    if (this.recovering && this.shard.recovery) await this.shard.recovery;
    if (this.failure) throw this.failure;
    try {
      const value = await this.shard.request('call', {
        runtimeId: this.id,
        method,
        args: wireCallArgs(args),
      }, method === 'abort' ? 15_000 : 10 * 60_000);
      if (method === 'dispose') this.shard.releaseProxy(this.id);
      return value;
    } catch (error) {
      if (method === 'dispose') this.shard.releaseProxy(this.id);
      throw error;
    }
  }
}

/**
 * Bounded multi-child shard pool.
 *
 * Fan-out is unchanged — every shard runs the same full agent/session graph —
 * but independent work is distributed so that no single event loop carries all
 * sessions, all provider parsing and all tool results. Machine-wide
 * authorities are deliberately NOT duplicated: child-spawn leases still flow
 * through each shard's IPC channel to the one daemon-side gate, and provider
 * capacity cooldowns discovered by one shard are replayed into the others.
 */
class SessionRuntimeShardPool {
  constructor({
    workerEntry,
    cwd,
    env,
    log,
    shardCount,
    onAgentSessionState,
    executeAgentControl,
  }) {
    this.log = typeof log === 'function' ? log : () => {};
    this.closed = false;
    this.ownership = createShardOwnership();
    this.dispatchOwners = new Map(); // dispatchId -> shard index
    this.agentControlOwners = new Map(); // controlId -> shard index
    this.agentControlRuns = new Map(); // controlId -> AbortController
    this.agentTaskOwners = new Map(); // taskId -> shard index
    this.agentTagOwners = new Map(); // ownerSessionId\0tag -> shard index
    this.agentSessionOwners = new Map(); // agent sessionId -> shard index
    this.agentOwnerOrigins = new Map(); // owner sessionId -> source shard index
    this.providerCooldown = { untilMs: 0, disabledReason: null, updatedAt: 0 };
    this.executeCanonicalAgentControl = typeof executeAgentControl === 'function'
      ? executeAgentControl
      : null;
    this.prewarmRequested = false;
    this.workloadCache = { refreshedAt: 0, shards: [] };
    this.workloadRefresh = null;
    // Hard bound, always: an explicit shardCount is operator/test input and
    // must never fork an unbounded number of runtime children.
    const count = normalizeShardCount(shardCount);
    this.shards = Array.from({ length: count }, (_, index) => new SessionRuntimeShard({
      index,
      pool: this,
      workerEntry,
      cwd,
      env: {
        ...env,
        MIXDOG_SESSION_RUNTIME_SHARD: String(index),
        MIXDOG_SESSION_RUNTIME_SHARD_COUNT: String(count),
      },
      log: this.log,
      onAgentSessionState,
    }));
  }

  get shardCount() {
    return this.shards.length;
  }

  shardAt(index) {
    const count = this.shards.length;
    const safe = ((Math.floor(Number(index) || 0) % count) + count) % count;
    return this.shards[safe];
  }

  liveShards() {
    return this.shards.filter((shard) => shard.isLive);
  }

  /** NEW work avoids a quarantined shard; work already owned never migrates
   *  (migration would strand accepted input in the abandoned child). */
  isPlaceable(index) {
    const shard = this.shards[index];
    return Boolean(shard) && !shard.degraded && !shard.closed;
  }

  placeKey(key) {
    return this.ownership.claim(
      key,
      () => selectShardIndex(key, this.shards.length, (index) => this.isPlaceable(index)),
    );
  }

  releaseOwnership(key) {
    if (!key) return;
    this.ownership.release(key);
  }

  async create(options = {}) {
    const runtimeId = randomUUID();
    const key = runtimeRoutingKey(options, runtimeId);
    const shard = this.shardAt(this.placeKey(key));
    try {
      return await shard.create(runtimeId, options, key);
    } catch (error) {
      this.releaseOwnership(key);
      throw error;
    }
  }

  /** Agent dispatches are independent units of work: hash placement spreads
   *  a batch fan-out across shards, and the recorded owner keeps cancel/abort
   *  addressed to the shard actually running it. */
  dispatchShard(dispatchId, { create = false } = {}) {
    const id = String(dispatchId || '');
    if (this.dispatchOwners.has(id)) return this.shardAt(this.dispatchOwners.get(id));
    if (!create) return null;
    const index = selectShardIndex(
      `dispatch:${id}`,
      this.shards.length,
      (candidate) => this.isPlaceable(candidate),
    );
    this.dispatchOwners.set(id, index);
    return this.shardAt(index);
  }

  releaseDispatch(dispatchId) {
    this.dispatchOwners.delete(String(dispatchId || ''));
  }

  agentTagKey(ownerSessionId, tag) {
    return `${String(ownerSessionId || '')}\0${String(tag || '')}`;
  }

  rememberAgentControlResult(index, args, context, value) {
    const text = String(value || '');
    const ownerSessionId = String(context?.callerSessionId || '');
    const taskId = String(
      args?.task_id
      || args?.taskId
      || (/^agent task:\s*(\S+)/m.exec(text)?.[1] || ''),
    );
    const target = /^target:\s*(\S+)(?:\s+(\S+))?/m.exec(text);
    const tag = String(args?.tag || (target?.[1] && target[1] !== '-' ? target[1] : ''));
    const sessionId = String(
      args?.sessionId
      || args?.session_id
      || (target?.[2] && /^sess_/.test(target[2]) ? target[2] : ''),
    );
    if (taskId) this.agentTaskOwners.set(taskId, index);
    if (tag) this.agentTagOwners.set(this.agentTagKey(ownerSessionId, tag), index);
    if (sessionId) this.agentSessionOwners.set(sessionId, index);
  }

  agentControlShard(originShard, args, context, controlId) {
    const ownerSessionId = String(context?.callerSessionId || '');
    const taskId = String(args?.task_id || args?.taskId || '');
    const sessionId = String(args?.sessionId || args?.session_id || '');
    const tag = String(args?.tag || '');
    let index = taskId ? this.agentTaskOwners.get(taskId) : null;
    if (index == null && sessionId) index = this.agentSessionOwners.get(sessionId);
    if (index == null && tag) index = this.agentTagOwners.get(this.agentTagKey(ownerSessionId, tag));
    if (index == null) {
      const key = `agent:${ownerSessionId}:${tag || sessionId || controlId}`;
      index = selectShardIndex(
        key,
        this.shards.length,
        (candidate) => this.isPlaceable(candidate),
      );
    }
    return this.shardAt(index ?? originShard?.index ?? 0);
  }

  async aggregateAgentStatus(context, originShard) {
    const targets = this.liveShards();
    if (targets.length === 0 && originShard) targets.push(originShard);
    const settled = await Promise.allSettled(targets.map((shard) =>
      shard.request('agent-control-status', { context }, 30_000)));
    const workers = new Map();
    const jobs = new Map();
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const worker of Array.isArray(result.value?.workers) ? result.value.workers : []) {
        const key = String(worker?.sessionId || worker?.tag || '');
        if (key) workers.set(key, worker);
      }
      for (const job of Array.isArray(result.value?.jobs) ? result.value.jobs : []) {
        const key = String(job?.task_id || job?.taskId || '');
        if (key) jobs.set(key, job);
      }
    }
    return renderAgentResult({ workers: [...workers.values()], jobs: [...jobs.values()] });
  }

  async executeAgentControl(originShard, args = {}, context = {}, controlId = randomUUID()) {
    const type = String(args?.type || 'spawn').trim().toLowerCase();
    const ownerSessionId = String(context?.callerSessionId || '');
    if (ownerSessionId && originShard) {
      this.agentOwnerOrigins.set(ownerSessionId, originShard.index);
    }
    if (type === 'list') return this.aggregateAgentStatus(context, originShard);
    if (type === 'cleanup' || type === '__close_all') {
      const targets = this.liveShards();
      const settled = await Promise.allSettled(targets.map((shard) =>
        shard.request('agent-control-local', {
          controlId: `${controlId}:${shard.index}`,
          args,
          context,
        }, 180_000)));
      return settled
        .filter((result) => result.status === 'fulfilled' && result.value)
        .map((result) => String(result.value))
        .join('\n');
    }
    const target = this.agentControlShard(originShard, args, context, controlId);
    this.agentControlOwners.set(controlId, target.index);
    try {
      let value = await target.request('agent-control-local', {
        controlId,
        args,
        context,
      }, 180_000);
      const lookup = type === 'status' || type === 'read' || type === 'cancel' || type === 'close';
      if (lookup && /^Error:/i.test(String(value || ''))) {
        for (const alternate of this.liveShards()) {
          if (alternate === target) continue;
          const candidate = await alternate.request('agent-control-local', {
            controlId: `${controlId}:${alternate.index}`,
            args,
            context,
          }, 180_000);
          if (/^Error:/i.test(String(candidate || ''))) continue;
          value = candidate;
          this.rememberAgentControlResult(alternate.index, args, context, value);
          return value;
        }
      }
      this.rememberAgentControlResult(target.index, args, context, value);
      return value;
    } finally {
      this.agentControlOwners.delete(controlId);
    }
  }

  handleAgentControl(originShard, originChild, message) {
    const controlId = String(message?.controlId || '');
    if (!controlId) return;
    const controller = new AbortController();
    this.agentControlRuns.set(controlId, controller);
    const context = {
      ...(message.context || {}),
      signal: controller.signal,
    };
    const ownerSessionId = String(context?.callerSessionId || '');
    if (ownerSessionId) {
      this.agentOwnerOrigins.set(ownerSessionId, originShard.index);
    }
    const execution = this.executeCanonicalAgentControl
      ? this.executeCanonicalAgentControl(message.args || {}, context)
      : Promise.reject(new Error('canonical Agent control is unavailable'));
    void Promise.resolve(execution).then((value) => {
      if (originShard.child !== originChild || originChild?.killed) return;
      safeIpcSend(originChild, {
        type: 'agent-control-result',
        controlId,
        ok: true,
        value,
      }, { onError: () => {} });
    }).catch((error) => {
      if (originShard.child !== originChild || originChild?.killed) return;
      safeIpcSend(originChild, {
        type: 'agent-control-result',
        controlId,
        ok: false,
        error: {
          name: String(error?.name || 'Error'),
          message: String(error?.message || error || 'agent control failed'),
          stack: typeof error?.stack === 'string' ? error.stack : null,
          code: error?.code || null,
        },
      }, { onError: () => {} });
    }).finally(() => {
      this.agentControlRuns.delete(controlId);
    });
  }

  cancelAgentControl(message) {
    const controlId = String(message?.controlId || '');
    const canonical = this.agentControlRuns.get(controlId);
    if (canonical) {
      try { canonical.abort(new Error(String(message?.reason || 'agent control canceled'))); } catch {}
      return true;
    }
    const index = this.agentControlOwners.get(controlId);
    if (index == null) return false;
    const shard = this.shardAt(index);
    void shard.request('agent-control-local-cancel', {
      controlId,
      reason: String(message?.reason || 'agent control canceled'),
    }, 5_000).catch(() => {});
    return true;
  }

  routeAgentControlNotification(message) {
    const ownerSessionId = String(message?.ownerSessionId || '');
    if (!ownerSessionId) return false;
    const index = this.agentOwnerOrigins.get(ownerSessionId)
      ?? this.ownership.peek(ownerSessionId);
    if (index == null) return false;
    return this.shardAt(index).sendAgentControlNotification(message);
  }

  async prewarm() {
    this.prewarmRequested = true;
    // Shard 0 always exists: its readiness is the daemon's prewarm contract.
    // Shards that have not forked yet stay cold (no idle worker per core) and
    // prewarm themselves the moment they spawn — see primeChild.
    const targets = new Set([this.shardAt(0), ...this.liveShards()]);
    const results = await Promise.allSettled(
      [...targets].map((shard) => shard.prewarmChild()),
    );
    const ready = results.find((result) => result.status === 'fulfilled');
    if (ready) return ready.value;
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return { ready: true };
  }

  primeChild(shard) {
    const cooldown = this.providerCooldown;
    if (cooldown.disabledReason || cooldown.untilMs > Date.now()) {
      shard.sendProviderCooldown(cooldown);
    }
    if (this.prewarmRequested && !this.closed) {
      // A shard that forks after the daemon's prewarm warms itself, so a
      // lazily spawned shard is never the cold one in a fan-out burst.
      void shard.prewarmChild().catch(() => {});
    }
  }

  /** Provider capacity cooldown is account-wide but observed per process:
   *  merge monotonically and replay to every sibling shard so a drained fast
   *  pool is never re-probed by the shards that did not see the rejection. */
  recordProviderCooldown(originShard, payload) {
    const admission = payload?.admission && typeof payload.admission === 'object'
      ? payload.admission
      : null;
    const merged = mergeProviderCooldown(this.providerCooldown, payload?.cooldown);
    if (merged.changed) this.providerCooldown = merged.cooldown;
    // An admission cooldown/reset event is forwarded the moment it happens —
    // siblings must stop probing a drained account immediately, not after the
    // next telemetry tick.
    if (!merged.changed && !admission) return false;
    const remainingS = Math.max(0, Math.round((this.providerCooldown.untilMs - Date.now()) / 1000));
    this.log(
      `session runtime provider cooldown from shard ${originShard?.index ?? '-'}`
      + ` → ${this.shards.length - 1} sibling shard(s)`
      + (admission ? ` [${admission.type}${admission.key ? ` ${admission.key}` : ''}]` : '')
      + ` (${this.providerCooldown.disabledReason ? `disabled: ${this.providerCooldown.disabledReason}` : `${remainingS}s`})`,
    );
    for (const shard of this.shards) {
      if (shard === originShard) continue;
      shard.sendProviderCooldown(this.providerCooldown, admission);
    }
    return true;
  }

  refreshWorkload() {
    if (this.workloadRefresh) return this.workloadRefresh;
    const live = this.liveShards();
    if (live.length === 0) {
      this.workloadCache = { refreshedAt: Date.now(), shards: [] };
      return Promise.resolve();
    }
    this.workloadRefresh = Promise.all(live.map((shard) => shard.workloadSnapshot()))
      .then((rows) => { this.workloadCache = { refreshedAt: Date.now(), shards: rows }; })
      .catch(() => { this.workloadCache = { refreshedAt: Date.now(), shards: [] }; })
      .finally(() => { this.workloadRefresh = null; });
    return this.workloadRefresh;
  }

  async close(reason) {
    this.closed = true;
    await Promise.allSettled(this.shards.map((shard) => shard.close(reason)));
  }

  get status() {
    const shards = this.shards.map((shard) => shard.status);
    const live = shards.filter((row) => row.pid);
    return {
      shardCount: this.shards.length,
      shards,
      // Back-compatible single-worker view for existing status consumers.
      worker: {
        pid: live[0]?.pid || null,
        pids: live.map((row) => row.pid),
        shards: this.shards.length,
        runtimes: shards.reduce((total, row) => total + row.runtimes, 0),
        pending: shards.reduce((total, row) => total + row.pending, 0),
        recycling: shards.some((row) => row.recycling),
        degraded: shards.filter((row) => row.degraded).length,
      },
    };
  }
}

export function createSessionRuntimeHost({
  workerEntry = fileURLToPath(new URL('./session-runtime-worker.mjs', import.meta.url)),
  cwd = process.cwd(),
  env = process.env,
  log = () => {},
  shardCount = null,
  executeAgentControl = null,
} = {}) {
  const pool = new SessionRuntimeShardPool({
    workerEntry,
    cwd,
    env,
    log,
    shardCount: Number(shardCount) > 0
      ? normalizeShardCount(shardCount)
      : resolveShardCount(),
    executeAgentControl,
  });
  // One machine-global native counter stays warm in the daemon. Session
  // runtimes relay requests over the worker IPC channel and never spawn
  // their own helper process.
  try { prewarmNativeTokenCounter(); } catch { /* JS/WASM fallback remains */ }
  let closed = false;

  // Runtime workload telemetry is refreshed lazily with a short TTL, across
  // every live shard.
  const WORKLOAD_TTL_MS = 2_000;
  function refreshRuntimeWorkload() {
    return pool.refreshWorkload();
  }

  return {
    async create(options = {}) {
      if (closed) throw new Error('session runtime host is closed');
      return pool.create(options);
    },
    prewarm() {
      return pool.prewarm();
    },
    // Agent execution rides the runtime worker instead of accumulating
    // provider/orchestrator churn in the daemon.
    async agentDispatch(payload = {}, { signal = null, timeoutMs = 60 * 60_000 } = {}) {
      if (closed) throw new Error('session runtime host is closed');
      const dispatchId = String(payload?.dispatchId || '');
      if (!dispatchId) throw new Error('agent dispatch id is required');
      // Placement is deterministic and recorded, so cancel/abort always reach
      // the shard that is actually running this dispatch.
      const shard = pool.dispatchShard(dispatchId, { create: true });
      const cancel = (reason) => {
        void shard.request('agent-dispatch-cancel', {
          dispatchId,
          reason: String(reason || 'agent dispatch canceled'),
        }, 10_000).catch(() => {});
      };
      if (signal?.aborted) {
        pool.releaseDispatch(dispatchId);
        throw new Error('agent dispatch canceled before start');
      }
      const onAbort = () => cancel(signal?.reason?.message || signal?.reason);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const result = await shard.request('agent-dispatch', payload, timeoutMs);
        return result?.value;
      } catch (error) {
        // The worker keeps running after a host-side timeout; tell it to stop.
        if (/timed out/.test(String(error?.message || ''))) cancel('agent dispatch timed out');
        throw error;
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
        pool.releaseDispatch(dispatchId);
      }
    },
    async agentControl(args = {}, context = {}) {
      if (closed) throw new Error('session runtime host is closed');
      if (typeof executeAgentControl === 'function') {
        return await executeAgentControl(args, context);
      }
      throw new Error('canonical Agent control is unavailable');
    },
    notifySessionCompletion(ownerSessionId, text, meta = {}) {
      return pool.routeAgentControlNotification({
        ownerSessionId: String(ownerSessionId || ''),
        text: String(text || ''),
        meta,
      });
    },
    async agentSessionAction(sessionId, action, args = []) {
      void sessionId;
      void action;
      void args;
      throw new Error('Agent sessions are owned by the canonical session service');
    },
    refreshRuntimeWorkload,
    subscribeAgentSessionStates(listener) {
      void listener;
      return () => {};
    },
    agentSessionState(sessionId) {
      void sessionId;
      return null;
    },
    get workloads() {
      if (!closed && Date.now() - pool.workloadCache.refreshedAt > WORKLOAD_TTL_MS) {
        void refreshRuntimeWorkload();
      }
      const shards = pool.workloadCache.shards;
      return {
        mode: pool.shardCount === 1 ? 'single-runtime' : 'multi-runtime-test',
        refreshedAt: pool.workloadCache.refreshedAt,
        machineSpawnBudget: machineSpawnSnapshot(),
        shardCount: pool.shardCount,
        shards,
        // Aggregate row keeps the historical single-worker shape.
        worker: aggregateShardWorkload(shards),
      };
    },
    async close(reason = 'session runtime host closed') {
      if (closed) return;
      closed = true;
      await pool.close(reason);
    },
    get status() {
      const status = pool.status;
      return {
        mode: status.shardCount === 1 ? 'single-runtime' : 'multi-runtime-test',
        active: Boolean(status.worker.pid),
        worker: status.worker,
        shards: status.shards,
        shardCount: status.shardCount,
        providerCooldown: pool.providerCooldown,
      };
    },
  };
}
