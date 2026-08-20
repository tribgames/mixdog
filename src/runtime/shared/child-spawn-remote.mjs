'use strict';

// Runtime-worker client for the MACHINE-WIDE child-spawn budget.
//
// child-spawn-gate's semaphore was written for the single-process daemon; the
// session-runtime split creates another process-local copy, which would
// multiply the intended machine-wide cap. In the runtime worker the gate
// therefore forwards each
// acquire as a lease request over the existing runtime IPC channel; the
// daemon-side host grants leases from its OWN child-spawn-gate instance,
// which becomes the single machine-wide authority (daemon-hosted maintenance
// agents already use that instance locally). Transport loss degrades to the
// local per-process lane — bounded, never unbounded.
import { safeIpcSend } from './safe-ipc-send.mjs';

const _pending = new Map(); // leaseId -> { grant, fail }
let _sequence = 0;
let _listening = false;
let _broken = false;

function _fallbackError(reason) {
  const error = new Error(`machine spawn budget unavailable (${reason}); using the local lane`);
  error.code = 'ELEASEFALLBACK';
  return error;
}

function _ensureListener() {
  if (_listening) return;
  _listening = true;
  process.on('message', (message) => {
    if (!message || typeof message !== 'object' || message.type !== 'spawn-lease-result') return;
    const pending = _pending.get(String(message.leaseId || ''));
    if (!pending) return;
    _pending.delete(String(message.leaseId || ''));
    if (message.ok === true) {
      pending.grant();
      return;
    }
    const error = new Error(String(message.error || 'spawn lease rejected'));
    if (message.code) error.code = String(message.code);
    if (message.statusCode) error.statusCode = Number(message.statusCode);
    pending.fail(error);
  });
  process.on('disconnect', () => {
    _broken = true;
    for (const [leaseId, pending] of [..._pending]) {
      _pending.delete(leaseId);
      pending.fail(_fallbackError('pool channel disconnected'));
    }
  });
}

export function remoteSpawnLeasesEnabled(env = process.env) {
  return !_broken
    && env.MIXDOG_SESSION_RUNTIME_WORKER === '1'
    && env.MIXDOG_DISABLE_MACHINE_SPAWN_BUDGET !== '1'
    && typeof process.send === 'function'
    && process.connected === true;
}

/**
 * Request one machine-wide spawn lease from the pool. Resolves to a release
 * function; rejects with code ELEASEFALLBACK when the pool channel cannot
 * answer (the caller then uses its bounded local lane), or with the pool's
 * real admission error (wait timeout / queue full) which must surface as-is.
 */
export function acquireRemoteSpawnLease({ lane, ownerKey, signal, waitTimeoutMs }) {
  _ensureListener();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? Object.assign(
      new Error('child-spawn-gate: aborted while queued'), { code: 'ABORT_ERR' },
    ));
  }
  const leaseId = `lease-${process.pid}-${++_sequence}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let safety = null;
    let onAbort = null;
    const cleanup = () => {
      if (safety) { clearTimeout(safety); safety = null; }
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* teardown */ }
        onAbort = null;
      }
      _pending.delete(leaseId);
    };
    const sendRelease = () => {
      safeIpcSend(process, { type: 'spawn-release', leaseId }, { onError: () => {} });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error?.code === 'ELEASEFALLBACK') _broken = true;
      reject(error);
    };
    const grant = () => {
      if (settled) {
        // Raced an abort/fallback: the slot is held by nobody — return it.
        sendRelease();
        return;
      }
      settled = true;
      cleanup();
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        sendRelease();
      });
    };
    _pending.set(leaseId, { grant, fail });
    if (signal) {
      onAbort = () => {
        // Cancels a queued lease (the pool aborts its waiter) or returns a
        // racing grant; either way the pool-side record settles exactly once.
        sendRelease();
        fail(signal.reason ?? Object.assign(
          new Error('child-spawn-gate: aborted while queued'), { code: 'ABORT_ERR' },
        ));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // The pool enforces the real waitTimeoutMs; this guard only covers a
    // parent that never answers (bug/kill) so a spawn can never hang forever.
    const budget = Math.max(1_000, Math.floor(Number(waitTimeoutMs) || 0)) + 5_000;
    safety = setTimeout(() => fail(_fallbackError(`no lease response in ${budget}ms`)), budget);
    safety.unref?.();
    const sent = safeIpcSend(process, {
      type: 'spawn-lease',
      leaseId,
      lane,
      ownerKey: String(ownerKey || ''),
      waitTimeoutMs,
    }, { onError: () => fail(_fallbackError('pool channel send failed')) });
    if (!sent) fail(_fallbackError('pool channel unavailable'));
  });
}
