import { freemem, totalmem } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestMemoryPressureSnapshot } from './memory-snapshot.mjs';

const MB = 1024 * 1024;

// The unified daemon queues bursts instead of starting an unbounded number of
// agent/provider/shell tasks in one process. Environment overrides remain
// available for larger hosts; memory thresholds are diagnostic only.
export const RESOURCE_ADMISSION_DEFAULTS = Object.freeze({
  maxAgents: 8,
  maxShells: 8,
  maxHighLoad: 12,
  maxQueue: 1024,
  minFreeMemoryMb: 0,
  maxRssMb: 0,
});

const PRIORITY_RANK = Object.freeze({
  'user-blocking': 0,
  'user-visible': 1,
  'best-effort': 2,
});

function normalizePriority(value) {
  const key = String(value || 'user-visible').toLowerCase();
  return Object.hasOwn(PRIORITY_RANK, key) ? key : 'user-visible';
}

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

class ResourcePressureError extends Error {
  constructor(message, details = {}) {
    super(`resource pressure: ${message}`);
    this.name = 'ResourcePressureError';
    this.code = 'ERESOURCEPRESSURE';
    Object.assign(this, details);
  }
}

class ResourceAdmissionQueueFullError extends ResourcePressureError {
  constructor(maxQueue) {
    super(`high-load admission queue full (maximum ${maxQueue}); retry after running work completes`, {
      maxQueue,
    });
    this.name = 'ResourceAdmissionQueueFullError';
    this.code = 'ERESOURCEQUEUEFULL';
  }
}

/**
 * Process-wide admission for memory-heavy agent work and child shells.
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
    this.activeByOwner = { agent: new Map(), shell: new Map() };
    this.fairCursor = { agent: null, shell: null };
    this.queue = [];
    // Live leases for saturation diagnostics only (labels/ages in snapshot()).
    this.activeLeases = new Set();
    this.context = new AsyncLocalStorage();
  }

  _recordMemoryPressure(kind) {
    // Thresholds are an operator-opt-in telemetry trigger only. The OS owns
    // memory pressure policy; Mixdog never turns a valid agent/shell request
    // into a failed task because of an RSS or host-free-memory sample.
    if (this.limits.maxRssMb <= 0 && this.limits.minFreeMemoryMb <= 0) return false;
    let sample;
    try { sample = this.metrics() || {}; }
    catch { return false; }
    const rssMb = Number(sample.rssBytes) / MB;
    const freeMb = Number(sample.freeMemoryBytes) / MB;
    if (this.limits.maxRssMb > 0 && Number.isFinite(rssMb) && rssMb >= this.limits.maxRssMb) {
      requestMemoryPressureSnapshot(
        `diagnostic threshold: Mixdog RSS ${Math.ceil(rssMb)} MB reached ${this.limits.maxRssMb} MB while starting ${kind}`,
      );
      return true;
    }
    if (this.limits.minFreeMemoryMb > 0 && Number.isFinite(freeMb) && freeMb < this.limits.minFreeMemoryMb) {
      requestMemoryPressureSnapshot(
        `diagnostic threshold: host free memory ${Math.floor(freeMb)} MB is below ${this.limits.minFreeMemoryMb} MB while starting ${kind}`,
      );
      return true;
    }
    return false;
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
      if (parent.ownerKey) {
        const owners = this.activeByOwner[parent.kind];
        const count = Math.max(0, (owners.get(parent.ownerKey) || 0) - 1);
        if (count > 0) owners.set(parent.ownerKey, count);
        else owners.delete(parent.ownerKey);
      }
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
      ownerKey: parent.ownerKey,
      priority: parent.priority,
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

  _lease(kind, queuedAt = null, parent = null, ownerKey = '', priority = 'user-visible') {
    this.active[kind] += 1;
    const owner = String(ownerKey || '');
    if (owner) this.activeByOwner[kind].set(owner, (this.activeByOwner[kind].get(owner) || 0) + 1);
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
      ownerKey: owner,
      priority: normalizePriority(priority),
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
          if (lease.ownerKey) {
            const count = Math.max(0, (this.activeByOwner[kind].get(lease.ownerKey) || 0) - 1);
            if (count > 0) this.activeByOwner[kind].set(lease.ownerKey, count);
            else this.activeByOwner[kind].delete(lease.ownerKey);
          }
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

  acquire(kind, {
    signal = null, label = null, dependency = 'scoped', ownerKey = null,
    priority = 'user-visible',
  } = {}) {
    const lane = kind === 'shell' ? 'shell' : 'agent';
    const owner = ownerKey == null ? '' : String(ownerKey).trim().slice(0, 240);
    const taskPriority = normalizePriority(priority);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    this._recordMemoryPressure(lane);
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
      const lease = this._lease(lane, null, parent, owner, taskPriority);
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
        ownerKey: owner,
        priority: taskPriority,
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

  _nextFairIndex() {
    const runnable = [];
    for (let index = 0; index < this.queue.length; index += 1) {
      const item = this.queue[index];
      if (item.canceled || item.signal?.aborted) continue;
      if (item.restore && item.parent.released) continue;
      if (!this._canStart(item.kind)) continue;
      runnable.push({ index, item });
    }
    if (runnable.length === 0) return -1;
    // USER_BLOCKING work (abort/recovery), then USER_VISIBLE tool work, then
    // BEST_EFFORT maintenance. Preserve FIFO between resource kinds inside a
    // priority and round-robin sessions within that lane.
    const bestRank = Math.min(...runnable.map(({ item }) =>
      PRIORITY_RANK[normalizePriority(item.priority)]));
    const prioritized = runnable.filter(({ item }) =>
      PRIORITY_RANK[normalizePriority(item.priority)] === bestRank);
    const lane = prioritized[0].item.kind;
    const laneRows = prioritized.filter((row) => row.item.kind === lane);
    const owners = [];
    for (const { item } of laneRows) {
      const owner = item.ownerKey || '';
      if (!owners.includes(owner)) owners.push(owner);
    }
    let selected = owners[0] || '';
    if (owners.length > 1) {
      const previous = this.fairCursor[lane];
      const previousIndex = owners.indexOf(previous);
      selected = owners[(previousIndex + 1 + owners.length) % owners.length];
    }
    this.fairCursor[lane] = selected;
    return laneRows.find((row) => (row.item.ownerKey || '') === selected)?.index ?? laneRows[0].index;
  }

  _drain() {
    for (;;) {
      // Remove dead/cancelled rows before selecting an owner. Their callbacks
      // may enqueue restoration work, so restart selection after each cleanup.
      let cleaned = false;
      for (let index = 0; index < this.queue.length; index += 1) {
        const item = this.queue[index];
      if (item.restore) {
        if (item.parent.released) {
          this.queue.splice(index, 1);
          this._detach(item);
          item.parent.restorePending = null;
          item.resolve();
          cleaned = true;
          break;
        }
        if (item.signal?.aborted) {
          this.queue.splice(index, 1);
          this._detach(item);
          item.parent.restorePending = null;
          item.reject(abortError(item.signal));
          cleaned = true;
          break;
        }
      }
      if (item.canceled || item.signal?.aborted) {
        this.queue.splice(index, 1);
        this._detach(item);
        const error = abortError(item.signal);
        this._resumeParent(item.parent).then(
          () => item.reject(error),
          (restoreError) => item.reject(restoreError),
        );
          cleaned = true;
          break;
        }
      }
      if (cleaned) continue;
      const index = this._nextFairIndex();
      if (index < 0) return;
      const item = this.queue[index];
      this._recordMemoryPressure(item.kind);
      this.queue.splice(index, 1);
      this._detach(item);
      if (item.restore) {
        item.parent.restorePending = null;
        item.parent.counted = true;
        this.active[item.kind] += 1;
        if (item.ownerKey) {
          this.activeByOwner[item.kind].set(
            item.ownerKey,
            (this.activeByOwner[item.kind].get(item.ownerKey) || 0) + 1,
          );
        }
        item.resolve();
        continue;
      }
      const lease = this._lease(
        item.kind,
        item.queuedAt,
        item.parent,
        item.ownerKey,
        item.priority,
      );
      lease.label = item.label;
      lease.signal = item.signal;
      item.resolve(lease);
    }
  }

  snapshot() {
    const now = this.now();
    const wireLimit = (value) => Number.isFinite(value) ? value : null;
    return {
      active: { ...this.active },
      activeOwners: {
        agent: this.activeByOwner.agent.size,
        shell: this.activeByOwner.shell.size,
      },
      queued: this.queue.length,
      limits: {
        ...this.limits,
        maxAgents: wireLimit(this.limits.maxAgents),
        maxShells: wireLimit(this.limits.maxShells),
        maxHighLoad: wireLimit(this.limits.maxHighLoad),
      },
      activeLeases: [...this.activeLeases].map((lease) => ({
        kind: lease.kind,
        label: lease.label,
        ownerKey: lease.ownerKey || null,
        priority: lease.priority,
        ageMs: Math.max(0, now - (lease.startedAt || now)),
      })),
      oldestQueuedMs: this.queue.reduce(
        (oldest, item) => Math.max(oldest, Math.max(0, now - (item.queuedAt || now))),
        0,
      ),
    };
  }
}

export const resourceAdmission = new ResourceAdmissionController();
