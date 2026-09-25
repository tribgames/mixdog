import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { hiddenSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import { withHeapCap } from '../runtime/shared/heap-cap.mjs';
import { snapshot as machineSpawnSnapshot } from '../runtime/shared/child-spawn-gate.mjs';
import { createRuntimeLagTracker } from '../runtime/shared/session-runtime-health.mjs';
import { ShardSpawnLeases } from './session-runtime-spawn-leases.mjs';
import {
  createShardOwnership,
  mergeProviderCooldown,
  normalizeShardCount,
  resolveShardCount,
  runtimeRoutingKey,
  selectShardIndex,
} from './session-runtime-shard-router.mjs';
import { AgentControlRouter } from './session-runtime-agent-control.mjs';
import { SessionRuntimeProxy } from './session-runtime-proxy.mjs';
import { aggregateShardWorkload } from './session-runtime-workload.mjs';

function logTurnTiming(shard, message) {
  const row = message.row && typeof message.row === 'object' ? message.row : {};
  const ms = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : -1);
  shard.log(
    `turn timing status=${row.status || 'unknown'} session=${row.sessionId || '-'}` +
      ` e2e=${ms(row.endToEndTtftMs)}ms runtime=${ms(row.ttftMs)}ms` +
      ` queue=${ms(row.queueMs)}ms route=${ms(row.routeMs)}ms` +
      ` preflight=${ms(row.preflightMs)}ms mcp=${ms(row.mcpMs)}ms` +
      ` provider=${ms(row.providerMs)}ms`
  );
}

// Child → host IPC messages other than request responses, by message type.
const CHILD_MESSAGE_HANDLERS = new Map([
  ['spawn-lease', (shard, message) => void shard.spawnLeases.grant(message)],
  ['spawn-release', (shard, message) => shard.spawnLeases.settle(String(message.leaseId || ''))],
  ['event-loop-lag', (shard, message) => shard.recordLag(message.sample)],
  ['provider-cooldown', (shard, message) => shard.pool?.recordProviderCooldown(shard, message)],
  ['agent-control', (shard, message, child) => void shard.pool?.agentControl.handleAgentControl(shard, child, message)],
  ['agent-control-cancel', (shard, message) => shard.pool?.agentControl.cancelAgentControl(message)],
  ['agent-control-notification', (shard, message) => shard.pool?.agentControl.routeAgentControlNotification(message)],
  ['unhealthy', (shard, message, child) => shard.recycleUnhealthy(child, message.detail)],
  ['state', (shard, message) => shard.proxies.get(String(message.runtimeId || ''))?.applyFrame(message)],
  ['turn-timing', logTurnTiming],
]);

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
    this.spawnLeases = new ShardSpawnLeases(this);
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
      this.handleChildFailure(child, new Error(`session runtime worker exited (${signal || code || 'unknown'})`));
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
    const handler = CHILD_MESSAGE_HANDLERS.get(message.type);
    if (handler) {
      handler(this, message, child);
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
    this.recovery ||= this.recover().finally(() => {
      this.recovery = null;
    });
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
        try {
          child?.kill?.();
        } catch {}
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
        try {
          child.kill?.();
        } catch {}
        return false;
      })
      .finally(() => {
        this.recycling = null;
      });
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
      // Every local failure path settles exactly once: a response already
      // handled by onMessage has dropped the pending entry.
      const settleReject = (error) => {
        if (!this.pending.delete(requestId)) return;
        if (request.timer) clearTimeout(request.timer);
        reject(error);
      };
      if (timeoutMs > 0) {
        request.timer = setTimeout(
          () => settleReject(new Error(`session runtime worker ${type} timed out`)),
          timeoutMs
        );
        request.timer.unref?.();
      }
      this.pending.set(requestId, request);
      if (!safeIpcSend(child, { type, requestId, ...payload }, { onError: settleReject })) {
        settleReject(new Error('session runtime worker IPC is unavailable'));
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
    const detail =
      `p95=${row?.p95Ms ?? -1}ms p99=${row?.p99Ms ?? -1}ms max=${row?.maxMs ?? -1}ms` +
      ` runtimes=${this.proxies.size}`;
    if (result.changed) {
      this.log(
        result.degraded
          ? `event-loop saturated ${detail} — quarantined from new placement`
          : `event-loop lag recovered ${detail} — placement resumed`
      );
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
    return safeIpcSend(
      child,
      {
        type: 'provider-cooldown-sync',
        cooldown,
        ...(admission ? { admission } : {}),
      },
      { onError: () => {} }
    );
  }

  sendAgentControlNotification(message) {
    const child = this.child;
    if (!child || child.killed || this.closed) return false;
    return safeIpcSend(
      child,
      {
        type: 'agent-control-notification',
        ownerSessionId: String(message?.ownerSessionId || ''),
        text: String(message?.text || ''),
        meta: message?.meta && typeof message.meta === 'object' ? message.meta : {},
      },
      { onError: () => {} }
    );
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

  releaseAllSpawnLeases() {
    this.spawnLeases.releaseAll();
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
    try {
      await this.requestRaw('shutdown', { reason }, 8_000);
    } catch {}
    try {
      child.disconnect?.();
    } catch {}
    // The child drains its accepted-input writes before exiting; a hard kill
    // inside that window is exactly what loses them.
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!exited) {
      try {
        child.kill?.();
      } catch {}
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
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
  constructor({ workerEntry, cwd, env, log, shardCount, onAgentSessionState, executeAgentControl }) {
    this.log = typeof log === 'function' ? log : () => {};
    this.closed = false;
    this.ownership = createShardOwnership();
    this.dispatchOwners = new Map(); // dispatchId -> shard index
    // Agent placement memory and the canonical-control bridge.
    this.agentControl = new AgentControlRouter(this, executeAgentControl);
    this.providerCooldown = { untilMs: 0, disabledReason: null, updatedAt: 0 };
    this.prewarmRequested = false;
    this.workloadCache = { refreshedAt: 0, shards: [] };
    this.workloadRefresh = null;
    // Hard bound, always: an explicit shardCount is operator/test input and
    // must never fork an unbounded number of runtime children.
    const count = normalizeShardCount(shardCount);
    this.shards = Array.from(
      { length: count },
      (_, index) =>
        new SessionRuntimeShard({
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
        })
    );
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
    return this.ownership.claim(key, () =>
      selectShardIndex(key, this.shards.length, (index) => this.isPlaceable(index))
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
    const index = selectShardIndex(`dispatch:${id}`, this.shards.length, (candidate) => this.isPlaceable(candidate));
    this.dispatchOwners.set(id, index);
    return this.shardAt(index);
  }

  releaseDispatch(dispatchId) {
    this.dispatchOwners.delete(String(dispatchId || ''));
  }

  async prewarm() {
    this.prewarmRequested = true;
    // Shard 0 always exists: its readiness is the daemon's prewarm contract.
    // Shards that have not forked yet stay cold (no idle worker per core) and
    // prewarm themselves the moment they spawn — see primeChild.
    const targets = new Set([this.shardAt(0), ...this.liveShards()]);
    const results = await Promise.allSettled([...targets].map((shard) => shard.prewarmChild()));
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
    const admission = payload?.admission && typeof payload.admission === 'object' ? payload.admission : null;
    const merged = mergeProviderCooldown(this.providerCooldown, payload?.cooldown);
    if (merged.changed) this.providerCooldown = merged.cooldown;
    // An admission cooldown/reset event is forwarded the moment it happens —
    // siblings must stop probing a drained account immediately, not after the
    // next telemetry tick.
    if (!merged.changed && !admission) return false;
    const remainingS = Math.max(0, Math.round((this.providerCooldown.untilMs - Date.now()) / 1000));
    const admissionKey = admission?.key ? ` ${admission.key}` : '';
    const admissionNote = admission ? ` [${admission.type}${admissionKey}]` : '';
    const { disabledReason } = this.providerCooldown;
    const cooldownState = disabledReason ? `disabled: ${disabledReason}` : `${remainingS}s`;
    this.log(
      `session runtime provider cooldown from shard ${originShard?.index ?? '-'}` +
        ` → ${this.shards.length - 1} sibling shard(s)${admissionNote} (${cooldownState})`
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
      .then((rows) => {
        this.workloadCache = { refreshedAt: Date.now(), shards: rows };
      })
      .catch(() => {
        this.workloadCache = { refreshedAt: Date.now(), shards: [] };
      })
      .finally(() => {
        this.workloadRefresh = null;
      });
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
    shardCount: Number(shardCount) > 0 ? normalizeShardCount(shardCount) : resolveShardCount(),
    executeAgentControl,
  });
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
        void shard
          .request(
            'agent-dispatch-cancel',
            {
              dispatchId,
              reason: String(reason || 'agent dispatch canceled'),
            },
            10_000
          )
          .catch(() => {});
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
      return pool.agentControl.routeAgentControlNotification({
        ownerSessionId: String(ownerSessionId || ''),
        text: String(text || ''),
        meta,
      });
    },
    async agentSessionAction(_sessionId, _action, _args = []) {
      throw new Error('Agent sessions are owned by the canonical session service');
    },
    refreshRuntimeWorkload,
    subscribeAgentSessionStates(_listener) {
      return () => {};
    },
    agentSessionState(_sessionId) {
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
