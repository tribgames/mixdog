import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { hiddenSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from './session-protocol.mjs';

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
  const base = previous && typeof previous === 'object' ? previous : {};
  const next = { ...base, ...(patch.set || {}) };
  if (patch.itemsAppend) {
    const items = Array.isArray(base.items) ? base.items : [];
    const from = Math.max(0, Math.floor(Number(patch.itemsAppend.from) || 0));
    next.items = items.slice(0, from).concat(patch.itemsAppend.values || []);
  }
  for (const key of patch.remove || []) delete next[key];
  return next;
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

  async close(reason) {
    this.closed = true;
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

  return {
    async create(options = {}) {
      if (closed) throw new Error('session runtime pool is closed');
      const sessionId = String(options.sessionId || '');
      const index = sessionId
        ? sessionShardIndex(sessionId, count)
        : (roundRobin++ % count);
      return shards[index].create(options);
    },
    prewarm() {
      return shards[0].request('prewarm', {}, 120_000);
    },
    async close(reason = 'session runtime pool closed') {
      if (closed) return;
      closed = true;
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
