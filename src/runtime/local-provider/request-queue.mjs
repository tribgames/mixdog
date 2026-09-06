import { DEFAULT_ACTIVITY_HEARTBEAT_MS } from '../agent/orchestrator/stall-policy.mjs';

export const DEFAULT_LOCAL_IDLE_TTL_SECONDS = 3600;

export function localIdleTtlSeconds(value = DEFAULT_LOCAL_IDLE_TTL_SECONDS) {
  if (!Number.isInteger(value) || value < 0 || value > 86400) {
    throw new TypeError('idleTtlSeconds must be an integer from 0 (disabled) to 86400.');
  }
  return value;
}

// Own the complete request, not just server startup. Idle unload joins the
// same chain, so new work can never race an unload in progress.
export function createLocalRequestQueue({
  unload = async () => {},
  idleTtlSeconds = DEFAULT_LOCAL_IDLE_TTL_SECONDS,
  maxQueue = 128,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  let chain = Promise.resolve();
  let timer = null;
  let idleDeadline = null;
  let active = 0;
  let lastUnloadError = null;
  let stopping = null;
  const requests = new Set();
  let ttl = localIdleTtlSeconds(idleTtlSeconds);
  function clearIdle() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    idleDeadline = null;
  }
  function serialize(operation) {
    const next = chain.then(operation, operation);
    chain = next.then(() => {}, () => {});
    return next;
  }
  function scheduleIdle() {
    clearIdle();
    if (requests.size || stopping || !ttl) return;
    idleDeadline = now() + ttl * 1000;
    timer = setTimer(() => {
      timer = null;
      idleDeadline = null;
      if (requests.size) return;
      void serialize(unload).then(() => { lastUnloadError = null; }, (error) => {
        lastUnloadError = String(error?.message || error);
      });
    }, ttl * 1000);
    timer?.unref?.();
  }
  return {
    run(operation, { signal, onStageChange } = {}) {
      signal?.throwIfAborted();
      if (stopping) return Promise.reject(new Error('[local-provider] local inference is stopping'));
      if (requests.size >= maxQueue + 1) return Promise.reject(new Error('[local-provider] request queue is full'));
      clearIdle();
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const request = { controller, started: false };
      requests.add(request);
      const waiting = () => {
        try { onStageChange?.('reconnecting', { message: 'Waiting for the local model', queueWait: true }); } catch {}
      };
      let heartbeat = null;
      if (requests.size > 1) {
        waiting();
        heartbeat = setInterval(waiting, DEFAULT_ACTIVITY_HEARTBEAT_MS);
        heartbeat.unref?.();
      }
      let rejectEarly;
      const early = new Promise((_resolve, reject) => { rejectEarly = reject; });
      const onAbort = () => {
        if (!request.started) {
          requests.delete(request);
          if (heartbeat) clearInterval(heartbeat);
          rejectEarly(combined.reason);
        }
      };
      combined.addEventListener('abort', onAbort, { once: true });
      const pending = serialize(async () => {
        if (heartbeat) clearInterval(heartbeat);
        combined.throwIfAborted();
        request.started = true;
        active++;
        try {
          try { onStageChange?.('requesting'); } catch {}
          return await operation(combined);
        } finally {
          active--;
        }
      }).finally(() => {
        combined.removeEventListener('abort', onAbort);
        if (heartbeat) clearInterval(heartbeat);
        requests.delete(request);
        scheduleIdle();
      });
      return Promise.race([pending, early]);
    },
    stop() {
      if (stopping) return stopping;
      clearIdle();
      for (const request of requests) request.controller.abort(new Error('[local-provider] local inference stopped'));
      // Interrupt loading/inference now; do not wait behind the work being stopped.
      stopping = (async () => {
        await unload();
        await chain;
        clearIdle();
      })().finally(() => { stopping = null; });
      return stopping;
    },
    configure(seconds) {
      const next = localIdleTtlSeconds(seconds);
      if (next === ttl) return;
      ttl = next;
      if (!requests.size) scheduleIdle();
    },
    status() {
      return { activeRequests: active, queuedRequests: Math.max(0, requests.size - active),
        idleTtlSeconds: ttl, idleDeadline, lastUnloadError };
    },
  };
}
