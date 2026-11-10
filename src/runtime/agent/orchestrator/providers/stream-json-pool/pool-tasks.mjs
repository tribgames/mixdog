/**
 * stream-json-pool/pool-tasks.mjs — the two task shapes a worker can be
 * handed. Every task carries `inline()` (the exact owner-thread equivalent
 * of the worker computation), `decode()` for the worker reply, and the
 * abort bookkeeping the slots consult when a worker answers late.
 */
import { frameAndParseSse } from '../lib/sse-framing.mjs';

export function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || 'provider stream parse canceled'));
}

export function parseInline(payloads) {
  return payloads.map((payload) => JSON.parse(payload));
}

export function createBatchTask({ id, payloads, bytes, owner, signal, resolve, reject, removeWaiting }) {
  const task = {
    id,
    kind: 'batch',
    owner,
    bytes,
    message: { id, payloads },
    inline: () => parseInline(payloads),
    decode: (result) => result.values,
    resolve,
    reject,
    aborted: false,
    onAbort: null,
    detach() {
      if (!task.onAbort || !signal) return;
      try {
        signal.removeEventListener('abort', task.onAbort);
      } catch {}
      task.onAbort = null;
    },
  };
  if (signal) {
    task.onAbort = () => {
      if (task.aborted) return;
      task.aborted = true;
      task.detach();
      removeWaiting(task);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', task.onAbort, { once: true });
  }
  return task;
}

export function createSseTask({ id, region, carry, bytes, owner, stats, resolve, reject }) {
  return {
    id,
    kind: 'sse',
    owner,
    bytes,
    message: { id, kind: 'sse', text: region, event: carry },
    inline: () => frameAndParseSse(region, carry),
    decode: (result) => ({
      events: Array.isArray(result?.events) ? result.events : [],
      currentEvent: String(result?.event || ''),
    }),
    resolve: (value) => {
      stats.framedEvents += Array.isArray(value?.events) ? value.events.length : 0;
      resolve(value);
    },
    reject,
    aborted: false,
    onAbort: null,
    detach() {},
  };
}
