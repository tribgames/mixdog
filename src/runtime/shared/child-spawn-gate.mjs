'use strict';

// ── Module-global child-spawn semaphore ──────────────────────────────────
//
// Single-daemon premise: tool execution is in-process, so a module-level
// singleton semaphore bounds the number of concurrent child processes (rg,
// mixdog-graph, …) across ALL agents/workers in this daemon. The goal is to
// absorb the over-saturation tail — when N agents fire grep/code_graph at
// once each child no longer fans out across every core, and the rg 20s
// deadline stops tripping en masse — WITHOUT serializing: up to the cap run
// concurrently, only the overflow queues and drains as slots free.
//
// IMPORTANT: this is a resource-control knob and is deliberately NOT exposed
// on any tool JSON schema / tool parameter surface. The only tuning surface
// is the internal constant + the MIXDOG_CHILD_SPAWN_MAX_INFLIGHT env override.

import os from 'node:os';

function _defaultMaxInflight() {
  const override = Number(process.env.MIXDOG_CHILD_SPAWN_MAX_INFLIGHT);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  let cpus = 0;
  try { cpus = os.cpus()?.length || 0; } catch { cpus = 0; }
  return Math.max(4, cpus || 4);
}

const MAX_INFLIGHT = _defaultMaxInflight();

// Warn (once-throttled, stderr only) when a waiter sat in the queue longer
// than this — a coarse signal that the cap is undersized for the load. Kept
// intentionally quiet so a busy daemon does not spam stderr.
const SLOW_WAIT_MS = Math.max(
  1000,
  Number(process.env.MIXDOG_CHILD_SPAWN_SLOW_MS) || 10000,
);
const SLOW_WARN_THROTTLE_MS = 30000;

let _inflight = 0;
/** @type {Array<{ resolve: () => void, reject: (e: any) => void, signal: AbortSignal | null, onAbort: (() => void) | null, enqueuedAt: number }>} */
const _queue = [];
let _lastSlowWarnAt = 0;

function _maybeWarnSlow(waitedMs) {
  if (waitedMs < SLOW_WAIT_MS) return;
  const now = Date.now();
  if (now - _lastSlowWarnAt < SLOW_WARN_THROTTLE_MS) return;
  _lastSlowWarnAt = now;
  try {
    process.stderr.write(
      `[child-spawn-gate] queue wait ${waitedMs}ms (inflight cap=${MAX_INFLIGHT}, queued=${_queue.length}); `
      + 'raise MIXDOG_CHILD_SPAWN_MAX_INFLIGHT if this persists\n',
    );
  } catch { /* ignore */ }
}

function _drain() {
  while (_inflight < MAX_INFLIGHT && _queue.length > 0) {
    const waiter = _queue.shift();
    if (waiter.onAbort && waiter.signal) {
      try { waiter.signal.removeEventListener('abort', waiter.onAbort); } catch { /* ignore */ }
    }
    _inflight++;
    _maybeWarnSlow(Date.now() - waiter.enqueuedAt);
    waiter.resolve();
  }
}

/**
 * Acquire one child-spawn slot. Resolves immediately when below the cap,
 * otherwise queues until a slot frees. The returned function releases the
 * slot and is idempotent (safe to call from multiple settle paths — only the
 * first call counts). Supports an optional AbortSignal: aborting while still
 * queued rejects with the signal reason and removes the waiter (no leak); a
 * post-acquire abort is a no-op here — the caller owns teardown and must still
 * call release().
 *
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<() => void>}
 */
export function acquire(signal = null) {
  if (signal && signal.aborted) {
    return Promise.reject(signal.reason ?? _abortError());
  }
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      _inflight = Math.max(0, _inflight - 1);
      _drain();
    };
    if (_inflight < MAX_INFLIGHT && _queue.length === 0) {
      _inflight++;
      resolve(release);
      return;
    }
    const waiter = {
      enqueuedAt: Date.now(),
      signal: signal || null,
      onAbort: null,
      resolve: () => resolve(release),
      reject,
    };
    if (signal) {
      waiter.onAbort = () => {
        const idx = _queue.indexOf(waiter);
        if (idx !== -1) _queue.splice(idx, 1);
        try { signal.removeEventListener('abort', waiter.onAbort); } catch { /* ignore */ }
        reject(signal.reason ?? _abortError());
      };
      try { signal.addEventListener('abort', waiter.onAbort, { once: true }); } catch { /* ignore */ }
    }
    _queue.push(waiter);
  });
}

function _abortError() {
  const e = new Error('child-spawn-gate: aborted while queued');
  e.code = 'ABORT_ERR';
  return e;
}

/**
 * Run `fn` while holding one child-spawn slot. Release is guaranteed in a
 * finally so a throw/return from `fn` cannot leak a slot or deadlock the gate.
 *
 * @template T
 * @param {(args: { signal: AbortSignal | null }) => Promise<T> | T} fn
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<T>}
 */
export async function withGate(fn, signal = null) {
  const release = await acquire(signal);
  try {
    return await fn({ signal: signal || null });
  } finally {
    release();
  }
}
