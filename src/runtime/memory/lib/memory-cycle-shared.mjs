// Shared memory helpers: logging, cancellation, concurrency and store faults.

import { __mixdogMemoryLog } from './memory-log.mjs';
export { __mixdogMemoryLog };

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
}

export function parseInterval(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!match) throw new Error(`[memory-cycle] invalid interval config: ${value}`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}

// Bounds concurrent summarization windows.
export function createSemaphore(limit) {
  const cap = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async (fn) => {
    if (active >= cap) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// Store failures must not be confused with rejected or cancelled work:
//   * STORE FAULT — the database itself failed the write (transaction rolled
//     back, or its COMMIT outcome is unknown). The store's state is no longer
//     known, so the run stops.
//   * rejection — a guard refused the mutation (stale snapshot, status
//     moved, content changed). The store is healthy;
//     these return normally and are counted as ordinary rejections/errors.
// Only writers raise store faults, via markStoreFault; callers branch on
// isStoreFault before absorbing an error into a per-action counter.
// Classification is TYPE-based, never text-based: the writer raises a dedicated
// error class, and `err instanceof MemoryStoreFault` is the decision. An
// explicit own field (`isMemoryStoreFault` + `code`) corroborates it for the
// cross-realm case where two copies of this module exist. Nothing about the
// error's message or name participates — a foreign provider/DB error is never
// reclassified because of how its text happens to read, and a store fault keeps
// the original message verbatim so logs stay honest.
//
// Embedding writers use this classification to retain ambiguous commit and
// rollback failures without disguising them as an empty successful flush.
export const MEMORY_STORE_FAULT_CODE = 'MEMORY_STORE_FAULT';

export class MemoryStoreFault extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MemoryStoreFault';
    this.code = MEMORY_STORE_FAULT_CODE;
    this.isMemoryStoreFault = true;
  }
}

export function markStoreFault(err) {
  if (isStoreFault(err)) return err;
  const cause = err instanceof Error ? err : new Error(String(err));
  // The original is never mutated (frozen/sealed store errors are ordinary):
  // it is carried as `cause`, with its message copied verbatim — unprefixed —
  // and its stack preserved so the failing statement stays visible.
  const fault = new MemoryStoreFault(cause.message || String(cause), { cause });
  if (typeof cause.stack === 'string') fault.stack = cause.stack;
  return fault;
}

export function isStoreFault(err) {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof MemoryStoreFault) return true;
  return err.isMemoryStoreFault === true && err.code === MEMORY_STORE_FAULT_CODE;
}
