import { createFairCallScheduler } from '../../standalone/fair-call-scheduler.mjs';
import { currentToolExecutionOwner } from './tool-execution-owner.mjs';

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function waitTimeoutError(name, waitTimeoutMs) {
  const error = new Error(`${name} admission wait exceeded ${waitTimeoutMs}ms; retry after running work completes`);
  error.code = 'EADMISSIONWAITTIMEOUT';
  error.statusCode = 503;
  error.waitTimeoutMs = waitTimeoutMs;
  return error;
}

/**
 * Owner-fair bounded work gate. The underlying scheduler lets a lone owner
 * borrow all capacity, then rotates contending session owners and rebalances a
 * full borrowed queue so a late interactive session is not trapped behind one
 * session's entire fan-out.
 */
export function createOwnerFairGate({
  name = 'work',
  activeMax = 8,
  queueMax = 1024,
  minOwnerQueue = 8,
  waitTimeoutMs = 30_000,
  schedule = setImmediate,
  now = Date.now,
} = {}) {
  const defaultWaitTimeoutMs = Math.max(0, Math.floor(Number(waitTimeoutMs) || 0));
  const scheduler = createFairCallScheduler({
    name,
    activeMax,
    queueMax,
    minOwnerQueue,
    dispatchBurst: Math.max(1, Math.min(8, positiveInt(activeMax, 8))),
    schedule,
    now,
  });
  const stats = {
    admitted: 0,
    rejected: 0,
    timedOut: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
  };

  function run(ownerKey, task, {
    signal = null,
    weight = 1,
    waitTimeoutMs: callWaitTimeoutMs = defaultWaitTimeoutMs,
    onAdmit = null,
  } = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError(`${name} task must be a function`));
    const owner = String(ownerKey || currentToolExecutionOwner() || 'anonymous').trim().slice(0, 240) || 'anonymous';
    const queuedAt = now();
    const timeoutMs = Math.max(0, Math.floor(Number(callWaitTimeoutMs) || 0));
    const controller = (signal || timeoutMs > 0) ? new AbortController() : null;
    let timer = null;
    let started = false;
    let timeoutError = null;
    let onAbort = null;

    const cleanupQueueWait = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
        onAbort = null;
      }
    };

    if (controller && signal) {
      onAbort = () => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (controller && timeoutMs > 0 && !controller.signal.aborted) {
      timer = setTimeout(() => {
        if (started || controller.signal.aborted) return;
        timeoutError = waitTimeoutError(name, timeoutMs);
        controller.abort(timeoutError);
      }, timeoutMs);
    }

    const promise = scheduler.enqueue(owner, async () => {
      started = true;
      cleanupQueueWait();
      const waitedMs = Math.max(0, now() - queuedAt);
      stats.admitted += 1;
      stats.totalWaitMs += waitedMs;
      stats.maxWaitMs = Math.max(stats.maxWaitMs, waitedMs);
      try { onAdmit?.(waitedMs); } catch {}
      return task();
    }, {
      weight,
      signal: controller?.signal || signal,
    });

    return promise.catch((error) => {
      if (!started) {
        stats.rejected += 1;
        if (timeoutError && error === timeoutError) stats.timedOut += 1;
      }
      throw error;
    }).finally(cleanupQueueWait);
  }

  function snapshot() {
    const base = scheduler.snapshot();
    return {
      ...base,
      admitted: stats.admitted,
      rejected: stats.rejected,
      timedOut: stats.timedOut,
      averageWaitMs: stats.admitted > 0 ? Math.round(stats.totalWaitMs / stats.admitted) : 0,
      maxWaitMs: stats.maxWaitMs,
    };
  }

  return {
    run,
    close: (reason) => scheduler.close(reason),
    snapshot,
    get active() { return scheduler.active; },
    get queued() { return scheduler.queued; },
  };
}
