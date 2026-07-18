import { freemem, totalmem } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestMemoryPressureSnapshot } from './memory-snapshot.mjs';

const MB = 1024 * 1024;

export const RESOURCE_ADMISSION_DEFAULTS = Object.freeze({
  maxAgents: 4,
  maxShells: 4,
  maxHighLoad: 6,
  maxQueue: 32,
  minFreeMemoryMb: 1024,
  maxRssMb: 3072,
});

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envLimits(env = process.env) {
  return {
    maxAgents: positiveInt(env.MIXDOG_MAX_CONCURRENT_AGENTS, RESOURCE_ADMISSION_DEFAULTS.maxAgents),
    maxShells: positiveInt(env.MIXDOG_MAX_CONCURRENT_SHELLS, RESOURCE_ADMISSION_DEFAULTS.maxShells),
    maxHighLoad: positiveInt(env.MIXDOG_MAX_CONCURRENT_HIGH_LOAD, RESOURCE_ADMISSION_DEFAULTS.maxHighLoad),
    maxQueue: nonNegativeInt(env.MIXDOG_RESOURCE_MAX_QUEUE, RESOURCE_ADMISSION_DEFAULTS.maxQueue),
    minFreeMemoryMb: nonNegativeInt(env.MIXDOG_MIN_FREE_MEMORY_MB, RESOURCE_ADMISSION_DEFAULTS.minFreeMemoryMb),
    maxRssMb: nonNegativeInt(env.MIXDOG_MAX_RSS_MB, RESOURCE_ADMISSION_DEFAULTS.maxRssMb),
  };
}

function defaultMetrics() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
  };
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || 'resource admission canceled'));
}

export class ResourcePressureError extends Error {
  constructor(message, details = {}) {
    super(`resource pressure: ${message}`);
    this.name = 'ResourcePressureError';
    this.code = 'ERESOURCEPRESSURE';
    Object.assign(this, details);
  }
}

export class ResourceAdmissionQueueFullError extends ResourcePressureError {
  constructor(maxQueue) {
    super(`high-load admission queue full (maximum ${maxQueue}); retry after running work completes`, {
      maxQueue,
    });
    this.name = 'ResourceAdmissionQueueFullError';
    this.code = 'ERESOURCEQUEUEFULL';
  }
}

/**
 * Process-wide admission for memory-heavy agent/explorer work and child shells.
 * Running work is never revoked: pressure only rejects a new request or keeps a
 * concurrency-blocked request in the bounded FIFO queue.
 */
export class ResourceAdmissionController {
  constructor({
    limits = {},
    metrics = defaultMetrics,
    now = Date.now,
    env = process.env,
  } = {}) {
    this.limits = { ...envLimits(env), ...limits };
    this.metrics = metrics;
    this.now = now;
    this.active = { agent: 0, shell: 0 };
    this.queue = [];
    // Live leases for saturation diagnostics only (labels/ages in snapshot()).
    this.activeLeases = new Set();
    this.context = new AsyncLocalStorage();
  }

  _memoryError(kind) {
    let sample;
    try { sample = this.metrics() || {}; }
    catch (error) {
      return new ResourcePressureError(`memory metrics unavailable; refusing new ${kind} work`, {
        kind,
        cause: error,
      });
    }
    const rssMb = Number(sample.rssBytes) / MB;
    const freeMb = Number(sample.freeMemoryBytes) / MB;
    if (this.limits.maxRssMb > 0 && Number.isFinite(rssMb) && rssMb >= this.limits.maxRssMb) {
      const error = new ResourcePressureError(
        `Mixdog RSS ${Math.ceil(rssMb)} MB reached ${this.limits.maxRssMb} MB limit; retry after memory recovers`,
        { kind, rssMb, limitMb: this.limits.maxRssMb, metric: 'rss' },
      );
      requestMemoryPressureSnapshot(error.message);
      return error;
    }
    if (this.limits.minFreeMemoryMb > 0 && Number.isFinite(freeMb) && freeMb < this.limits.minFreeMemoryMb) {
      const error = new ResourcePressureError(
        `host free memory ${Math.floor(freeMb)} MB is below ${this.limits.minFreeMemoryMb} MB minimum; retry after memory recovers`,
        { kind, freeMb, limitMb: this.limits.minFreeMemoryMb, metric: 'free-memory' },
      );
      requestMemoryPressureSnapshot(error.message);
      return error;
    }
    return null;
  }

  _canStart(kind) {
    const total = this.active.agent + this.active.shell;
    const kindLimit = kind === 'shell' ? this.limits.maxShells : this.limits.maxAgents;
    return total < this.limits.maxHighLoad && this.active[kind] < kindLimit;
  }

  _suspendParent(parent) {
    if (!parent || parent.controller !== this || parent.released) return null;
    parent.dependencyDepth += 1;
    if (parent.counted) {
      parent.counted = false;
      this.active[parent.kind] = Math.max(0, this.active[parent.kind] - 1);
    }
    return parent;
  }

  _resumeParent(parent) {
    if (!parent) return Promise.resolve();
    parent.dependencyDepth = Math.max(0, parent.dependencyDepth - 1);
    if (parent.dependencyDepth > 0 || parent.released || parent.counted) return Promise.resolve();
    if (parent.restorePending) return parent.restorePending.promise;
    const pending = Promise.withResolvers();
    const item = {
      restore: true,
      kind: parent.kind,
      label: `restore:${parent.label || parent.kind}`,
      queuedAt: this.now(),
      signal: parent.signal,
      parent,
      resolve: pending.resolve,
      reject: pending.reject,
      canceled: false,
      onAbort: null,
    };
    parent.restorePending = { ...pending, item };
    if (item.signal) {
      item.onAbort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        this._detach(item);
        parent.restorePending = null;
        item.reject(abortError(item.signal));
        this._drain();
      };
      item.signal.addEventListener('abort', item.onAbort, { once: true });
    }
    this.queue.push(item);
    this._drain();
    return pending.promise;
  }

  _lease(kind, queuedAt = null, parent = null) {
    this.active[kind] += 1;
    const lease = {
      controller: this,
      kind,
      label: null,
      signal: null,
      counted: true,
      released: false,
      dependencyDepth: 0,
      restorePending: null,
      parent,
      releasePromise: null,
      startedAt: this.now(),
      queuedMs: queuedAt == null ? 0 : Math.max(0, this.now() - queuedAt),
      release: () => {
        if (lease.released) return lease.releasePromise || Promise.resolve();
        lease.released = true;
        this.activeLeases.delete(lease);
        if (lease.restorePending) {
          const item = lease.restorePending.item;
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          this._detach(item);
          lease.restorePending = null;
          item.resolve();
        }
        if (lease.counted) {
          lease.counted = false;
          this.active[kind] = Math.max(0, this.active[kind] - 1);
        }
        lease.releasePromise = this._resumeParent(lease.parent);
        this._drain();
        return lease.releasePromise;
      },
      detachDependency: () => {
        if (!lease.parent) return Promise.resolve();
        const dependencyParent = lease.parent;
        lease.parent = null;
        const restored = this._resumeParent(dependencyParent);
        this._drain();
        return restored;
      },
    };
    this.activeLeases.add(lease);
    return lease;
  }

  runWithLease(lease, task) {
    if (!lease || lease.controller !== this || typeof task !== 'function') {
      return Promise.resolve().then(task);
    }
    return this.context.run(lease, task);
  }

  acquire(kind, { signal = null, label = null, dependency = 'scoped' } = {}) {
    const lane = kind === 'shell' ? 'shell' : 'agent';
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const pressure = this._memoryError(lane);
    if (pressure) return Promise.reject(pressure);
    const ambientParent = this.context.getStore();
    const detachedDependency = dependency === 'detached' && ambientParent?.controller === this;
    const parent = detachedDependency ? null : this._suspendParent(ambientParent);
    if (detachedDependency && (!this._canStart(lane) || this.queue.length > 0)) {
      const error = new ResourcePressureError(
        `detached nested ${lane} work has no admission capacity; retry after running work completes`,
        { kind: lane },
      );
      error.code = 'ERESOURCEDEPENDENCY';
      return Promise.reject(error);
    }
    if (this._canStart(lane) && this.queue.length === 0) {
      const lease = this._lease(lane, null, parent);
      lease.label = label;
      lease.signal = signal;
      return Promise.resolve(lease);
    }
    if (this.queue.length >= this.limits.maxQueue) {
      const error = new ResourceAdmissionQueueFullError(this.limits.maxQueue);
      return this._resumeParent(parent).then(
        () => Promise.reject(error),
        (restoreError) => Promise.reject(restoreError),
      );
    }
    return new Promise((resolve, reject) => {
      const item = {
        kind: lane,
        label,
        queuedAt: this.now(),
        signal,
        resolve,
        reject,
        canceled: false,
        onAbort: null,
        parent,
      };
      if (signal) {
        item.onAbort = () => {
          if (item.canceled) return;
          item.canceled = true;
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          this._detach(item);
          const error = abortError(signal);
          this._resumeParent(item.parent).then(
            () => reject(error),
            (restoreError) => reject(restoreError),
          );
          this._drain();
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      this.queue.push(item);
      this._drain();
    });
  }

  _detach(item) {
    if (item.onAbort && item.signal) {
      try { item.signal.removeEventListener('abort', item.onAbort); } catch {}
      item.onAbort = null;
    }
  }

  _drain() {
    for (let index = 0; index < this.queue.length;) {
      const item = this.queue[index];
      if (item.restore) {
        if (item.parent.released) {
          this.queue.splice(index, 1);
          this._detach(item);
          item.parent.restorePending = null;
          item.resolve();
          continue;
        }
        if (item.signal?.aborted) {
          this.queue.splice(index, 1);
          this._detach(item);
          item.parent.restorePending = null;
          item.reject(abortError(item.signal));
          continue;
        }
        if (!this._canStart(item.kind)) {
          index += 1;
          continue;
        }
        this.queue.splice(index, 1);
        this._detach(item);
        item.parent.restorePending = null;
        item.parent.counted = true;
        this.active[item.kind] += 1;
        item.resolve();
        continue;
      }
      if (item.canceled || item.signal?.aborted) {
        this.queue.splice(index, 1);
        this._detach(item);
        const error = abortError(item.signal);
        this._resumeParent(item.parent).then(
          () => item.reject(error),
          (restoreError) => item.reject(restoreError),
        );
        continue;
      }
      if (!this._canStart(item.kind)) {
        index += 1;
        continue;
      }
      const pressure = this._memoryError(item.kind);
      this.queue.splice(index, 1);
      this._detach(item);
      if (pressure) {
        this._resumeParent(item.parent).then(
          () => item.reject(pressure),
          (restoreError) => item.reject(restoreError),
        );
        continue;
      }
      const lease = this._lease(item.kind, item.queuedAt, item.parent);
      lease.label = item.label;
      lease.signal = item.signal;
      item.resolve(lease);
    }
  }

  snapshot() {
    const now = this.now();
    return {
      active: { ...this.active },
      queued: this.queue.length,
      limits: { ...this.limits },
      activeLeases: [...this.activeLeases].map((lease) => ({
        kind: lease.kind,
        label: lease.label,
        ageMs: Math.max(0, now - (lease.startedAt || now)),
      })),
    };
  }
}

export const resourceAdmission = new ResourceAdmissionController();
