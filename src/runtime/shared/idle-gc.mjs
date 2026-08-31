// Idle-time garbage collection for long-lived hosts.
//
// V8 defers a major collection while the old-space limit is still far away, so
// a process that churns large transcripts keeps hundreds of MB of already
// unreachable objects for as long as nothing forces a sweep. Measured on a
// live daemon: heapUsed 320MB collapsed to 180MB in 98ms — 44% of the heap was
// garbage that simply had no reason to be collected yet.
//
// The sweep runs ONLY while the host reports itself idle, so its pause never
// lands inside a turn, and it goes through the in-process inspector rather
// than --expose-gc: no launch flag, no debugger port, and none of the detached
// contexts the vm.runInNewContext('gc') trick leaves behind.

import { Session } from 'node:inspector';

const DISABLED = /^(0|false|off)$/i;
const MB = 1024 * 1024;

function envNumber(name, fallback, min = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

/**
 * Run a full collection without requiring --expose-gc at launch.
 * Returns false when neither path is available, so the caller can stand down
 * instead of burning a timer forever.
 */
export async function collectGarbageNow() {
  // A host already launched with --expose-gc gets the cheaper direct call.
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  let session = null;
  try {
    session = new Session();
    session.connect();
    await new Promise((resolve, reject) => {
      session.post('HeapProfiler.collectGarbage', (err) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  } finally {
    try { session?.disconnect(); } catch { /* already gone */ }
  }
}

/**
 * Sweep dead objects while the host is idle.
 *
 * @param {object} options
 * @param {() => boolean} options.isBusy Reports real work in flight. Treated as
 *   busy when it throws, so a broken probe can never trigger a pause mid-turn.
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.label] Log prefix.
 */
export function createIdleGc({ isBusy, log = () => {}, label = 'idle gc' } = {}) {
  const enabled = !DISABLED.test(String(process.env.MIXDOG_IDLE_GC || ''));
  // Long enough that the pause between two turns of one conversation never
  // triggers a sweep, short enough that a desktop left alone reclaims soon.
  const idleMs = envNumber('MIXDOG_IDLE_GC_IDLE_MS', 60_000, 1_000);
  const checkMs = Math.max(5_000, Math.round(idleMs / 4));
  // Under this the sweep costs more than it returns. Measured on the live
  // daemon hosting six sessions: heapUsed 102MB against a 180MB committed
  // total. The previous 192MB floor sat above the heap this process actually
  // reaches, so the sweep never ran once and the 78MB V8 was holding idle was
  // never handed back.
  const minHeapBytes = envNumber('MIXDOG_IDLE_GC_MIN_HEAP_MB', 96) * MB;
  // V8 keeps whole pages committed after the objects on them die, so a heap
  // that LOOKS small can still sit on a large committed total. A wide gap
  // between committed and used is itself a reason to sweep — the collection is
  // what lets V8 release those pages — so either signal alone arms the sweep.
  const minSlackBytes = envNumber('MIXDOG_IDLE_GC_MIN_SLACK_MB', 64) * MB;
  // Re-sweeping a process that has not allocated since the last sweep only
  // burns CPU; require real growth before running again.
  const growthBytes = envNumber('MIXDOG_IDLE_GC_GROWTH_MB', 64) * MB;

  let timer = null;
  let lastBusyAt = Date.now();
  let lastSweptHeap = 0;
  let sweeping = false;

  async function tick() {
    if (sweeping) return 'sweeping';
    let busy = true;
    try { busy = isBusy() === true; } catch { busy = true; }
    if (busy) {
      lastBusyAt = Date.now();
      return 'busy';
    }
    if (Date.now() - lastBusyAt < idleMs) return 'settling';
    const usageBefore = process.memoryUsage();
    const before = usageBefore.heapUsed;
    const slackBefore = Math.max(0, usageBefore.heapTotal - before);
    if (before < minHeapBytes && slackBefore < minSlackBytes) return 'small';
    if (lastSweptHeap && before < lastSweptHeap + growthBytes) return 'unchanged';

    sweeping = true;
    const startedAt = Date.now();
    try {
      if (!(await collectGarbageNow())) {
        log(`${label} unavailable in this runtime — standing down`);
        disarm();
        return 'unavailable';
      }
      const usageAfter = process.memoryUsage();
      const after = usageAfter.heapUsed;
      lastSweptHeap = after;
      const mb = (bytes) => (bytes / MB).toFixed(1);
      // Committed total is reported beside the live heap because that is the
      // number the OS actually charges this process for.
      log(
        `${label}: heapUsed ${mb(before)} -> ${mb(after)} MB`
        + ` (reclaimed ${mb(before - after)} MB) in ${Date.now() - startedAt}ms`
        + `, committed ${mb(usageBefore.heapTotal)} -> ${mb(usageAfter.heapTotal)} MB`,
      );
      return 'swept';
    } catch (e) {
      log(`${label} failed: ${e?.message || e}`);
      return 'failed';
    } finally {
      sweeping = false;
    }
  }

  function arm() {
    if (!enabled || timer) return false;
    // Unref'd: reclaiming memory must never be the reason a process stays up.
    timer = setInterval(() => { void tick(); }, checkMs);
    timer.unref?.();
    return true;
  }

  function disarm() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    arm,
    disarm,
    get armed() { return timer !== null; },
    /** Drives one cycle synchronously for tests; returns the decision taken. */
    _tickForTest: tick,
    _configForTest: { enabled, idleMs, checkMs, minHeapBytes, minSlackBytes, growthBytes },
  };
}
