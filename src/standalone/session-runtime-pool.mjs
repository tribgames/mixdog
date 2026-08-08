import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { hiddenSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import {
  acquire as acquireMachineSpawnSlot,
  snapshot as machineSpawnSnapshot,
} from '../runtime/shared/child-spawn-gate.mjs';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from './session-protocol.mjs';
import { applySessionStatePatch } from './session-state-patch.mjs';

const RUNTIME_METHODS = new Set([
  ...SESSION_READ_ACTIONS,
  ...SESSION_CONFIGURE_ACTIONS,
  'reserveSession',
  'resume',
  'submitAsync',
  'abort',
  'resolveToolApproval',
  'dispose',
]);

function configuredShardCount() {
  const explicit = Math.floor(Number(process.env.MIXDOG_SESSION_SHARDS));
  if (Number.isFinite(explicit) && explicit >= 1) return Math.min(32, explicit);
  const parallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(2, Math.min(8, parallelism - 1));
}

/** How many shards the background spread-prewarm keeps warm. Agent shard
 *  spread places a Lead's workers on peer shards, so a fanout onto cold
 *  shards pays fork + module graph + keychain + provider init inline. Four
 *  warm shards (Lead + three peers under the resident cap) absorb an
 *  8-worker fanout; MIXDOG_SESSION_SHARD_PREWARM overrides (N, 'all', or
 *  0/off for shard-0-only). */
export function configuredSpreadPrewarmCount(shardCount) {
  const raw = String(process.env.MIXDOG_SESSION_SHARD_PREWARM ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 1;
  if (raw === 'all') return Math.max(1, shardCount);
  const explicit = Math.floor(Number(raw));
  if (Number.isFinite(explicit) && explicit >= 1) return Math.min(explicit, shardCount);
  return Math.min(4, Math.max(1, shardCount));
}

export function sessionShardIndex(sessionId, shardCount) {
  const count = Math.max(1, Math.floor(Number(shardCount)) || 1);
  const text = String(sessionId || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

export function applyShardStateFrame(previous, frame) {
  if (frame?.full && typeof frame.full === 'object') return frame.full;
  const patch = frame?.patch;
  if (!patch || typeof patch !== 'object') return previous || {};
  return applySessionStatePatch(previous, patch);
}

// Placement caps. A live (prewarmed) shard absorbs cold-hash creates up to
// these bounds; past either bound the hash shard takes over, because event-
// loop isolation matters more than spawn latency once a shard is carrying a
// real concurrent workload (a Lead plus its agents share ONE shard loop).
const WARM_SHARD_SOFT_CAP = 4;
const WARM_SHARD_BUSY_CAP = 2;

/** Pure placement rule (unit-tested): a live hash shard always wins; a cold
 *  hash spills to the least-BUSY live shard under both caps; otherwise the
 *  hash shard boots. `shards` rows are { alive, resident, busy }.
 *  `avoidIndex` (agent shard spread) excludes the caller's own shard when the
 *  pool has an alternative, so a Lead's workers never land back on its loop. */
export function chooseShardIndex({
  hashIndex,
  shards,
  residentCap = WARM_SHARD_SOFT_CAP,
  busyCap = WARM_SHARD_BUSY_CAP,
  avoidIndex = null,
} = {}) {
  const avoid = Number.isInteger(avoidIndex) && shards.length > 1 ? avoidIndex : -1;
  const hashShard = shards[hashIndex];
  if (hashIndex !== avoid && hashShard?.alive) return hashIndex;
  let best = -1;
  for (let index = 0; index < shards.length; index += 1) {
    const info = shards[index];
    if (index === avoid) continue;
    if (!info?.alive) continue;
    if (info.resident >= residentCap) continue;
    if (info.busy >= busyCap) continue;
    if (best === -1) { best = index; continue; }
    const current = shards[best];
    if (info.busy < current.busy
      || (info.busy === current.busy && info.resident < current.resident)) best = index;
  }
  if (best !== -1) return best;
  if (avoid === -1 || hashIndex !== avoid) return hashIndex;
  // Every alternative is cold or capped and the hash shard is the avoided
  // loop: boot the next shard over rather than sharing the caller's loop.
  return (avoid + 1) % shards.length;
}

class SessionShard {
  constructor(index, { workerEntry, cwd, env, log }) {
    this.index = index;
    this.workerEntry = workerEntry;
    this.cwd = cwd;
    this.env = env;
    this.log = log;
    this.child = null;
    this.pending = new Map();
    this.proxies = new Map();
    this.sequence = 0;
    this.closed = false;
    this.recovery = null;
    this.failedChildren = new WeakSet();
    this.lastActivityAt = Date.now();
    this.coolingDown = null; // in-flight coolDown promise
    // Machine-wide spawn leases held on behalf of this shard's child process.
    this.spawnLeases = new Map(); // leaseId -> { release, controller, settled }
  }

  ensureChild() {
    if (this.child && !this.child.killed) return this.child;
    if (this.closed) throw new Error(`session shard ${this.index} is closed`);
    const child = fork(this.workerEntry, [], {
      cwd: this.cwd,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...this.env,
        MIXDOG_SESSION_SHARD_INDEX: String(this.index),
      },
      ...hiddenSpawnOpts,
    });
    this.child = child;
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) this.log(`session shard ${this.index}: ${text}`);
    });
    child.on('message', (message) => this.onMessage(message));
    child.on('error', (error) => this.handleChildFailure(child, error));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.handleChildFailure(
        child,
        new Error(`session shard ${this.index} exited (${signal || code || 'unknown'})`),
      );
    });
    return child;
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'spawn-lease') {
      void this.grantSpawnLease(message);
      return;
    }
    if (message.type === 'spawn-release') {
      this.settleSpawnLease(String(message.leaseId || ''));
      return;
    }
    if (message.type === 'state') {
      this.proxies.get(String(message.runtimeId || ''))?.applyFrame(message);
      return;
    }
    if (message.type !== 'response') return;
    const request = this.pending.get(String(message.requestId || ''));
    if (!request) return;
    this.pending.delete(request.id);
    if (request.timer) clearTimeout(request.timer);
    if (message.ok === false) {
      const error = new Error(String(message.error?.message || 'session shard call failed'));
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
        this.log(`session shard ${this.index} recovered ${this.proxies.size} runtime(s)`);
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
    const error = lastError || new Error(`session shard ${this.index} recovery failed`);
    for (const proxy of this.proxies.values()) proxy.fail(error);
    return false;
  }

  requestRaw(type, payload = {}, timeoutMs = 10 * 60_000) {
    this.lastActivityAt = Date.now();
    const child = this.ensureChild();
    const requestId = `shard-${this.index}-${process.pid}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const request = { id: requestId, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        request.timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          reject(new Error(`session shard ${this.index} ${type} timed out`));
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
        reject(new Error(`session shard ${this.index} IPC is unavailable`));
      }
    });
  }

  async request(type, payload = {}, timeoutMs = 10 * 60_000) {
    if (this.recovery) await this.recovery;
    if (this.coolingDown) await this.coolingDown.catch(() => {});
    return this.requestRaw(type, payload, timeoutMs);
  }

  async create(options) {
    const runtimeId = randomUUID();
    const proxy = new SessionRuntimeProxy(runtimeId, this, options);
    this.proxies.set(runtimeId, proxy);
    try {
      await this.request('create', { runtimeId, options }, 120_000);
      return proxy;
    } catch (error) {
      this.proxies.delete(runtimeId);
      throw error;
    }
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
        ownerKey: `shard${this.index}:${String(message.ownerKey || 'anonymous')}`,
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

  /** Soft shutdown: stop the child but keep the shard REUSABLE (cold-down).
   *  ensureChild() re-forks on the next create/prewarm. */
  async coolDown(reason = 'idle shard cold-down') {
    if (this.closed || !this.child) return false;
    if (this.proxies.size > 0 || this.pending.size > 0 || this.spawnLeases.size > 0) return false;
    this.coolingDown = this.stopChild(reason).finally(() => { this.coolingDown = null; });
    await this.coolingDown;
    return true;
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
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    if (!exited) {
      try { child.kill?.(); } catch {}
      await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    this.child = null;
  }

  get status() {
    return {
      index: this.index,
      pid: this.child?.pid || null,
      runtimes: this.proxies.size,
      pending: this.pending.size,
    };
  }
}

class SessionRuntimeProxy {
  constructor(id, shard, options) {
    this.id = id;
    this.shard = shard;
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
    this.state = applyShardStateFrame(this.state, frame);
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
        args,
      }, method === 'abort' ? 15_000 : 10 * 60_000);
      if (method === 'dispose') this.shard.proxies.delete(this.id);
      return value;
    } catch (error) {
      if (method === 'dispose') this.shard.proxies.delete(this.id);
      throw error;
    }
  }
}

export function createSessionRuntimePool({
  shardCount = configuredShardCount(),
  workerEntry = fileURLToPath(new URL('./session-runtime-worker.mjs', import.meta.url)),
  cwd = process.cwd(),
  env = process.env,
  log = () => {},
  coldDownMs = null,
  coldDownSweepMs = null,
} = {}) {
  const count = Math.max(1, Math.min(32, Math.floor(Number(shardCount)) || 1));
  const shards = Array.from({ length: count }, (_, index) => new SessionShard(index, {
    workerEntry,
    cwd,
    env,
    log,
  }));
  let roundRobin = 0;
  let closed = false;
  // Warm-but-EMPTY peer shards hold ~120-150MB RSS each. After this idle
  // window a runtime-less shard (never shard 0) is cooled down — the child
  // exits, the shard stays reusable, and an agent-fanout create re-warms the
  // spread on demand below. 0 disables.
  const COLD_DOWN_MS = Number(coldDownMs) >= 0
    ? Number(coldDownMs)
    : Math.max(0, Number(process.env.MIXDOG_SESSION_SHARD_COLDDOWN_MS ?? 15 * 60_000));
  const COLD_DOWN_SWEEP_MS = Number(coldDownSweepMs) > 0 ? Number(coldDownSweepMs) : 60_000;
  let coldDownTimer = null;
  function startColdDownSweep() {
    if (coldDownTimer || !(COLD_DOWN_MS > 0)) return;
    coldDownTimer = setInterval(() => {
      if (closed) return;
      const now = Date.now();
      for (const shard of shards) {
        if (shard.index === 0) continue; // first-session shard stays warm
        if (!shard.child || shard.child.killed || shard.coolingDown) continue;
        if (shard.proxies.size > 0 || shard.pending.size > 0) continue;
        if (now - shard.lastActivityAt < COLD_DOWN_MS) continue;
        void shard.coolDown().then((cooled) => {
          if (cooled) log(`session shard ${shard.index} cooled down after idle`);
        }).catch(() => { /* next sweep retries */ });
      }
    }, COLD_DOWN_SWEEP_MS);
    coldDownTimer.unref?.();
  }
  startColdDownSweep();
  // One background spread-prewarm at a time; an agent create re-arms it when
  // the warm set has cooled below the configured target.
  let spreadPrewarmInFlight = null;

  // Shard ids are hashed for an even spread, but a fresh session id carries no
  // affinity: nothing outside this pool derives placement from the hash. When
  // the hash shard is cold, answering the create from an already-live
  // (prewarmed) shard removes fork + module graph + keychain + provider init
  // from the first-turn critical path. Live shards are preferred by
  // chooseShardIndex up to a resident AND a busy cap, so a Lead running its
  // agents never accumulates every new session on its own event loop.
  function shardPlacementInfo() {
    return shards.map((shard) => {
      const alive = Boolean(shard.child && !shard.child.killed && !shard.coolingDown);
      let busy = 0;
      if (alive) {
        for (const proxy of shard.proxies.values()) {
          const state = proxy.state || {};
          if (state.busy === true || state.commandBusy === true
            || (Array.isArray(state.queued) && state.queued.length > 0)) busy += 1;
        }
      }
      return { alive, resident: shard.proxies.size, busy };
    });
  }
  function placementShardIndex(sessionId, avoidIndex = null) {
    return chooseShardIndex({
      hashIndex: sessionShardIndex(sessionId, count),
      shards: shardPlacementInfo(),
      avoidIndex,
    });
  }

  // Shard workload telemetry (child-spawn lanes, tool I/O gates, resource
  // admission) refreshed lazily with a short TTL: the daemon status panel was
  // blind to shard-process gates and reported only its own idle instances.
  const WORKLOAD_TTL_MS = 2_000;
  let workloadCache = { refreshedAt: 0, shards: [] };
  let workloadRefresh = null;
  function refreshShardWorkloads() {
    if (workloadRefresh) return workloadRefresh;
    const alive = shards.filter((shard) => shard.child && !shard.child.killed);
    workloadRefresh = Promise.all(alive.map(async (shard) => {
      try {
        const value = await shard.request('workload', {}, 2_000);
        return { index: shard.index, pid: shard.child?.pid || null, ...value };
      } catch (error) {
        return { index: shard.index, error: String(error?.message || error) };
      }
    })).then((rows) => {
      workloadCache = { refreshedAt: Date.now(), shards: rows };
    }).finally(() => { workloadRefresh = null; });
    return workloadRefresh;
  }

  return {
    async create(options = {}) {
      if (closed) throw new Error('session runtime pool is closed');
      const sessionId = String(options.sessionId || '');
      const avoidIndex = Number.isInteger(options.avoidShardIndex) ? options.avoidShardIndex : null;
      // An agent-fanout create re-arms the background spread-prewarm when the
      // cold-down sweep has shrunk the warm set below the configured target,
      // so only the first wave after a quiet period pays any cold boots.
      if (options.agentSession && !spreadPrewarmInFlight) {
        const warm = shards.filter((shard) => shard.child && !shard.child.killed).length;
        if (warm < Math.min(configuredSpreadPrewarmCount(count), count)) {
          spreadPrewarmInFlight = this.prewarmSpread({ staggerMs: 500 })
            .catch(() => {})
            .finally(() => { spreadPrewarmInFlight = null; });
        }
      }
      let index = sessionId
        ? placementShardIndex(sessionId, avoidIndex)
        : (roundRobin++ % count);
      if (!sessionId && avoidIndex !== null && count > 1 && index === avoidIndex) {
        index = (index + 1) % count;
      }
      // One line per agent create: enough to reconstruct why a fanout landed
      // where it did (a cold boot paid while a warm peer sat empty is a bug).
      if (options.agentSession) {
        const rows = shardPlacementInfo()
          .map((row, at) => `${at}${row.alive ? '+' : '-'}${row.resident}b${row.busy}`)
          .join(' ');
        log(`agent placement ${sessionId.slice(-8) || `rr${index}`} hash=${sessionShardIndex(sessionId, count)}`
          + ` avoid=${avoidIndex ?? '-'} -> shard ${index} [${rows}]`);
      }
      return shards[index].create(options);
    },
    prewarm() {
      // One warm shard is enough: placementShardIndex routes cold-hash creates
      // to it, so the first session never pays a cold shard fork inline.
      return shards[0].request('prewarm', {}, 120_000);
    },
    /** Background spread-prewarm: warm the first `count` shards one at a time
     *  (staggered so boot never pays an N-process fork burst). Failures are
     *  per-shard and non-fatal — a cold shard still boots on demand. */
    async prewarmSpread({ count: requestedCount = null, staggerMs = 2_000 } = {}) {
      const target = Math.max(1, Math.min(
        Math.floor(Number(requestedCount ?? configuredSpreadPrewarmCount(count))) || 1,
        count,
      ));
      const warmed = [];
      for (let index = 0; index < target; index += 1) {
        if (closed) break;
        try {
          await shards[index].request('prewarm', {}, 120_000);
          warmed.push(index);
        } catch (error) {
          log(`session shard ${index} spread-prewarm failed (non-fatal): ${error?.message || error}`);
        }
        if (index + 1 < target && staggerMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, staggerMs);
            timer.unref?.();
          });
        }
      }
      return warmed;
    },
    refreshShardWorkloads,
    /** Cached machine-wide workload view: the daemon-side spawn budget (the
     *  lease authority) plus each live shard's gate snapshots. Reads stay
     *  sync for the status surface; staleness kicks a background refresh. */
    get workloads() {
      if (!closed && Date.now() - workloadCache.refreshedAt > WORKLOAD_TTL_MS) {
        void refreshShardWorkloads();
      }
      return {
        refreshedAt: workloadCache.refreshedAt,
        machineSpawnBudget: machineSpawnSnapshot(),
        shards: workloadCache.shards,
      };
    },
    async close(reason = 'session runtime pool closed') {
      if (closed) return;
      closed = true;
      if (coldDownTimer) {
        clearInterval(coldDownTimer);
        coldDownTimer = null;
      }
      await Promise.allSettled(shards.map((shard) => shard.close(reason)));
    },
    get status() {
      return {
        count,
        active: shards.filter((shard) => shard.child).length,
        shards: shards.map((shard) => shard.status),
      };
    },
  };
}
