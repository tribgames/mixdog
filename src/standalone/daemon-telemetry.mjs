// Periodic daemon memory + in-flight work telemetry.
//
// Owns the single unref'd 30s diagnostics loop (event-loop lag rides
// onInterval on the same tick) so a crash still has a recent
// RSS/heap/limit/work record in daemon.log. The V8 heap limit is
// process-specific (heap_size_limit) and is never inferred from host
// free RAM. Lines contain only counters — no session bodies, tokens,
// or env. Retention is the daemon log's existing rotate-and-keep bound.

import v8 from 'node:v8';

export const DAEMON_TELEMETRY_INTERVAL_MS = 30_000;

const WORK_KEYS = Object.freeze(['activeCalls', 'queuedCalls', 'busySessions', 'busyMemoryAgents']);
const REASONS = new Set(['boot', 'periodic']);

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function byteCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : -1;
}

function timestamp(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string' && value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
  } catch {
    /* fall through */
  }
  return new Date().toISOString();
}

function processId(pid) {
  const n = Number(pid);
  return Number.isInteger(n) ? n : process.pid;
}

function workCounts(work) {
  const source = work && typeof work === 'object' ? work : {};
  const counts = {};
  for (const key of WORK_KEYS) counts[key] = nonNegativeInt(source[key]);
  return counts;
}

function readMemory(memoryUsage) {
  try {
    return memoryUsage?.() || {};
  } catch {
    return {};
  }
}

function readHeapLimit(heapStatistics) {
  try {
    return byteCount(heapStatistics?.()?.heap_size_limit);
  } catch {
    return -1;
  }
}

function reasonToken(reason) {
  const text = String(reason ?? '').toLowerCase();
  return REASONS.has(text) ? text : 'periodic';
}

export function collectDaemonTelemetry({
  now = () => new Date(),
  pid = process.pid,
  memoryUsage = () => process.memoryUsage(),
  heapStatistics = () => v8.getHeapStatistics(),
  work = {},
} = {}) {
  const usage = readMemory(memoryUsage);
  return {
    ts: timestamp(now),
    pid: processId(pid),
    rssBytes: byteCount(usage.rss),
    heapUsedBytes: byteCount(usage.heapUsed),
    heapTotalBytes: byteCount(usage.heapTotal),
    heapLimitBytes: readHeapLimit(heapStatistics),
    externalBytes: byteCount(usage.external),
    arrayBufferBytes: byteCount(usage.arrayBuffers),
    ...workCounts(work),
  };
}

/**
 * Tracks the smallest heapUsed observed right after a major GC (mark-sweep-
 * compact) — the retained-set size, which heapUsed at an arbitrary instant
 * hides. Sampled per telemetry interval; no per-GC logging. Returns null when
 * PerformanceObserver is unavailable.
 */
export function createPostGcHeapTracker({
  heapUsed = () => v8.getHeapStatistics().used_heap_size,
  observe = (onGc) => {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onGc(entry);
    });
    obs.observe({ entryTypes: ['gc'] });
    return () => obs.disconnect();
  },
} = {}) {
  let min = -1;
  let disconnect = null;
  try {
    disconnect = observe((entry) => {
      // NODE_PERFORMANCE_GC_MAJOR = 4 (older Node: entry.kind); newer: entry.detail.kind.
      const kind = entry?.detail?.kind ?? entry?.kind;
      if (kind !== 4) return;
      const used = byteCount(heapUsed());
      if (used >= 0 && (min < 0 || used < min)) min = used;
    });
  } catch {
    return null;
  }
  return {
    /** Min post-major-GC heap since the last take; -1 when none ran. */
    take() {
      const value = min;
      min = -1;
      return value;
    },
    stop() {
      try {
        disconnect?.();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Builds the `describeStall(fromMono, toMono)` the owner heartbeat appends to
 * its stall line: the spans that overlapped the stall window plus the in-flight
 * work snapshot at report time. Counters and labels only.
 */
export function createStallDescriber({ spans, getWork = () => ({}), limit = 3 } = {}) {
  return (fromMono, toMono) => {
    const parts = [];
    const overlapping = spans?.describe(fromMono, toMono, limit);
    if (overlapping) parts.push(overlapping);
    const work = workCounts(getWork());
    parts.push(
      `in-flight: activeCalls=${work.activeCalls} queuedCalls=${work.queuedCalls}` +
        ` busySessions=${work.busySessions} busyMemoryAgents=${work.busyMemoryAgents}`
    );
    return parts.join(' | ');
  };
}

export function formatDaemonTelemetry(record, reason = 'periodic') {
  const row = record && typeof record === 'object' ? record : collectDaemonTelemetry();
  return [
    'daemon-telemetry',
    `reason=${reasonToken(reason)}`,
    `ts=${row.ts}`,
    `pid=${row.pid}`,
    `rssBytes=${row.rssBytes}`,
    `heapUsedBytes=${row.heapUsedBytes}`,
    `heapTotalBytes=${row.heapTotalBytes}`,
    `heapLimitBytes=${row.heapLimitBytes}`,
    `externalBytes=${row.externalBytes}`,
    `arrayBufferBytes=${row.arrayBufferBytes}`,
    `activeCalls=${row.activeCalls}`,
    `queuedCalls=${row.queuedCalls}`,
    `busySessions=${row.busySessions}`,
    `busyMemoryAgents=${row.busyMemoryAgents}`,
    // Present only when a major GC ran since the previous line.
    ...(byteCount(row.postGcHeapMinBytes) >= 0 ? [`postGcHeapMinBytes=${row.postGcHeapMinBytes}`] : []),
  ].join(' ');
}

export function createDaemonTelemetry({
  log = () => {},
  getWork = () => ({}),
  onInterval = null,
  // Runs once when the loop starts, before its first window: a probe that
  // judges each window (the lag profiler) arms here so the first one covers
  // boot instead of starting only at the first tick.
  onStart = null,
  now,
  pid,
  memoryUsage,
  heapStatistics,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  createGcTracker = createPostGcHeapTracker,
} = {}) {
  let timer = null;
  let gcTracker = null;

  function emit(reason = 'periodic') {
    try {
      let work = {};
      try {
        work = getWork();
      } catch {
        work = {};
      }
      const record = collectDaemonTelemetry({
        now,
        pid,
        memoryUsage,
        heapStatistics,
        work,
      });
      const postGc = gcTracker?.take() ?? -1;
      if (postGc >= 0) record.postGcHeapMinBytes = postGc;
      log(formatDaemonTelemetry(record, reason));
      return record;
    } catch {
      return null;
    }
  }

  function tick() {
    emit('periodic');
    try {
      onInterval?.();
    } catch {
      /* lag probes must not kill the sample loop */
    }
  }

  function start(intervalMs = DAEMON_TELEMETRY_INTERVAL_MS) {
    if (timer) return timer;
    gcTracker ??= createGcTracker();
    const delay = Number(intervalMs);
    const ms = Number.isFinite(delay) && delay > 0 ? delay : DAEMON_TELEMETRY_INTERVAL_MS;
    const handle = setIntervalFn(() => {
      if (timer !== handle) return;
      tick();
    }, ms);
    handle?.unref?.();
    timer = handle;
    try {
      onStart?.();
    } catch {
      /* a start probe must not stop the sample loop */
    }
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
    gcTracker?.stop();
    gcTracker = null;
  }

  return { emit, start, stop };
}
