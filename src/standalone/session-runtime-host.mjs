import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { hiddenSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import {
  acquire as acquireMachineSpawnSlot,
  snapshot as machineSpawnSnapshot,
} from '../runtime/shared/child-spawn-gate.mjs';
import {
  countTokensNative,
  prewarmNativeTokenCounter,
} from '../runtime/agent/orchestrator/session/token-native.mjs';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from './session-protocol.mjs';
import { applySessionStatePatch } from './session-state-patch.mjs';

const RUNTIME_METHODS = new Set([
  ...SESSION_READ_ACTIONS,
  ...SESSION_CONFIGURE_ACTIONS,
  'readModelMessages',
  'reserveSession',
  'resume',
  'submitAsync',
  'abort',
  'resolveToolApproval',
  'dispose',
]);

export function applyRuntimeStateFrame(previous, frame) {
  if (frame?.full && typeof frame.full === 'object') return frame.full;
  const patch = frame?.patch;
  if (!patch || typeof patch !== 'object') return previous || {};
  return applySessionStatePatch(previous, patch);
}

class SessionRuntimeWorker {
  constructor({ workerEntry, cwd, env, log }) {
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
    this.recycling = null;
    this.failedChildren = new WeakSet();
    // Machine-wide spawn leases held on behalf of the runtime child process.
    this.spawnLeases = new Map(); // leaseId -> { release, controller, settled }
  }

  ensureChild() {
    if (this.child && !this.child.killed) return this.child;
    if (this.closed) throw new Error('session runtime worker is closed');
    const child = fork(this.workerEntry, [], {
      cwd: this.cwd,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...this.env },
      ...hiddenSpawnOpts,
    });
    this.child = child;
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) this.log(`session runtime worker: ${text}`);
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
    return child;
  }

  onMessage(message, child = this.child) {
    if (!message || typeof message !== 'object') return;
    // A superseded child (recycled, crashed, or replaced) can still flush
    // queued frames after its replacement is live. Its late state/response must
    // never outrank the replacement's revision or settle its pending calls.
    if (child !== this.child) return;
    if (message.type === 'token-native-prewarm') {
      if (child === this.child) prewarmNativeTokenCounter();
      return;
    }
    if (message.type === 'token-native-count') {
      void this.handleTokenNativeCount(child, message);
      return;
    }
    if (message.type === 'spawn-lease') {
      void this.grantSpawnLease(message);
      return;
    }
    if (message.type === 'spawn-release') {
      this.settleSpawnLease(String(message.leaseId || ''));
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

  async handleTokenNativeCount(child, message) {
    const tokenRequestId = String(message.tokenRequestId || '');
    if (!tokenRequestId || child !== this.child || child?.killed) return;
    let count = null;
    try {
      count = await countTokensNative(String(message.text ?? ''));
    } catch {}
    if (child !== this.child || child?.killed) return;
    safeIpcSend(child, {
      type: 'token-native-result',
      tokenRequestId,
      count: Number.isFinite(count) && count >= 0 ? count : null,
    }, { onError: () => {} });
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
      this.log(`session runtime worker superseded child failed (ignored): ${error?.message || error}`);
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
        this.log(`session runtime worker recovered ${this.proxies.size} runtime(s)`);
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

  recycleUnhealthy(child, detail = null) {
    if (this.closed || child !== this.child || this.recycling) return;
    const reason = String(detail?.reason || 'session runtime worker reported unhealthy');
    this.log(`session runtime worker unhealthy; recycling pid=${child.pid || 'unknown'}: ${reason}`);
    this.recycling = this.stopChild(`unhealthy: ${reason}`)
      .catch((error) => {
        this.log(`session runtime worker unhealthy recycle failed: ${error?.message || error}`);
        try { child.kill?.(); } catch {}
      })
      .finally(() => { this.recycling = null; });
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
      pid: this.child?.pid || null,
      runtimes: this.proxies.size,
      pending: this.pending.size,
      recycling: Boolean(this.recycling),
    };
  }
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
  constructor(id, host, options) {
    this.id = id;
    this.host = host;
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
      void this.host.request('snapshot', { runtimeId: this.id }, 5_000).catch(() => {});
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
    await this.host.requestRaw('create', {
      runtimeId: this.id,
      options: this.options,
    }, 120_000);
    if (previousSessionId) {
      const resumed = await this.host.requestRaw('call', {
        runtimeId: this.id,
        method: 'resume',
        args: [previousSessionId],
      }, 120_000);
      if (resumed !== true) {
        await this.host.requestRaw('call', {
          runtimeId: this.id,
          method: 'reserveSession',
          args: [previousSessionId],
        }, 30_000);
      }
    }
    await this.host.requestRaw('snapshot', { runtimeId: this.id }, 5_000);
    this.failure = null;
    this.recovering = false;
  }

  async call(method, args) {
    if (this.recovering && this.host.recovery) await this.host.recovery;
    if (this.failure) throw this.failure;
    try {
      const value = await this.host.request('call', {
        runtimeId: this.id,
        method,
        args: wireCallArgs(args),
      }, method === 'abort' ? 15_000 : 10 * 60_000);
      if (method === 'dispose') this.host.proxies.delete(this.id);
      return value;
    } catch (error) {
      if (method === 'dispose') this.host.proxies.delete(this.id);
      throw error;
    }
  }
}

export function createSessionRuntimeHost({
  workerEntry = fileURLToPath(new URL('./session-runtime-worker.mjs', import.meta.url)),
  cwd = process.cwd(),
  env = process.env,
  log = () => {},
} = {}) {
  const worker = new SessionRuntimeWorker({
    workerEntry,
    cwd,
    env,
    log,
  });
  // One machine-global native counter stays warm in the daemon. Session
  // runtimes relay requests over the worker IPC channel and never spawn
  // their own helper process.
  try { prewarmNativeTokenCounter(); } catch { /* JS/WASM fallback remains */ }
  let closed = false;

  // Runtime workload telemetry is refreshed lazily with a short TTL.
  const WORKLOAD_TTL_MS = 2_000;
  let workloadCache = { refreshedAt: 0, worker: null };
  let workloadRefresh = null;
  function refreshRuntimeWorkload() {
    if (workloadRefresh) return workloadRefresh;
    if (!worker.child || worker.child.killed) {
      workloadCache = { refreshedAt: Date.now(), worker: null };
      return Promise.resolve();
    }
    workloadRefresh = worker.request('workload', {}, 2_000)
      .then((value) => {
        workloadCache = {
          refreshedAt: Date.now(),
          worker: { pid: worker.child?.pid || null, ...value },
        };
      })
      .catch((error) => {
        workloadCache = {
          refreshedAt: Date.now(),
          worker: { pid: worker.child?.pid || null, error: String(error?.message || error) },
        };
      })
      .finally(() => { workloadRefresh = null; });
    return workloadRefresh;
  }

  return {
    async create(options = {}) {
      if (closed) throw new Error('session runtime host is closed');
      return worker.create(options);
    },
    prewarm() {
      return worker.request('prewarm', {}, 120_000);
    },
    refreshRuntimeWorkload,
    get workloads() {
      if (!closed && Date.now() - workloadCache.refreshedAt > WORKLOAD_TTL_MS) {
        void refreshRuntimeWorkload();
      }
      return {
        refreshedAt: workloadCache.refreshedAt,
        machineSpawnBudget: machineSpawnSnapshot(),
        worker: workloadCache.worker,
      };
    },
    async close(reason = 'session runtime host closed') {
      if (closed) return;
      closed = true;
      await worker.close(reason);
    },
    get status() {
      const status = worker.status;
      return {
        active: Boolean(status.pid),
        worker: status,
      };
    },
  };
}
