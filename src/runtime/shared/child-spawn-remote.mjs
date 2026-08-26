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
// "Lost" means the parent IPC link is actually gone — never merely slow. A
// single timed-out or failed lease must NOT latch this process onto the
// process-local lane: with several runtime shards that silently multiplies the
// machine-wide child-spawn cap, which is exactly the Windows spawn storm this
// gate exists to prevent.
let _channelLost = false;
// Bounded patience for a busy/recovering daemon. Each expiry re-arms while the
// link is alive, so IPC latency keeps shards on the machine-wide budget.
const LEASE_WAIT_EXTENSIONS = Math.max(
  0,
  Math.floor(Number(process.env.MIXDOG_SPAWN_LEASE_WAIT_EXTENSIONS) || 3),
);
const LEASE_WARN_THROTTLE_MS = 30_000;
let _lastLeaseWarnAt = 0;

function _warnSlowLease(budgetMs, extensionsLeft) {
  const now = Date.now();
  if (now - _lastLeaseWarnAt < LEASE_WARN_THROTTLE_MS) return;
  _lastLeaseWarnAt = now;
  try {
    process.stderr.write(
      `[child-spawn-remote] machine spawn lease pending >${budgetMs}ms; staying on the daemon budget`
      + ` (${extensionsLeft} extension(s) left)\n`,
    );
  } catch { /* diagnostics only */ }
}

function _fallbackError(reason) {
  const error = new Error(`machine spawn budget unavailable (${reason}); using the local lane`);
  error.code = 'ELEASEFALLBACK';
  return error;
}

function _leaseTimeoutError(reason) {
  const error = new Error(`machine spawn budget did not answer (${reason}); spawn was not started`);
  error.code = 'ESPAWNLEASETIMEOUT';
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
    _channelLost = true;
    for (const [leaseId, pending] of [..._pending]) {
      _pending.delete(leaseId);
      pending.fail(_fallbackError('pool channel disconnected'));
    }
  });
}

/**
 * PID-accurate shard detection. MIXDOG_SESSION_RUNTIME_WORKER is inherited by
 * every grandchild (tools, helpers, spawned nodes), so the plain flag cannot
 * decide who owns a runtime IPC channel: only the process whose OWN pid matches
 * the pid-scoped marker is a runtime shard. A grandchild therefore uses its own
 * bounded local lane, and a real shard is never misread into it.
 */
export function isSessionRuntimeWorkerProcess(env = process.env, pid = process.pid) {
  return String(env.MIXDOG_SESSION_RUNTIME_WORKER_PID || '') === String(pid);
}

export function remoteSpawnLeasesEnabled(env = process.env) {
  return !_channelLost
    && isSessionRuntimeWorkerProcess(env)
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
    let extensionsLeft = LEASE_WAIT_EXTENSIONS;
    const armSafety = () => {
      safety = setTimeout(() => {
        // A busy or recovering daemon is latency, not a broken budget
        // authority: while the link is alive, keep waiting instead of dropping
        // to a per-process lane that multiplies the machine-wide cap.
        if (extensionsLeft > 0 && !_channelLost && process.connected === true) {
          extensionsLeft -= 1;
          _warnSlowLease(budget, extensionsLeft);
          armSafety();
          return;
        }
        // A still-connected authority may be wedged, but bypassing it would
        // multiply the machine cap by the shard count. Fail this spawn instead;
        // only an actually lost IPC channel is allowed to use the bounded
        // process-local fallback lane.
        fail(process.connected === true && !_channelLost
          ? _leaseTimeoutError(`no lease response in ${budget}ms`)
          : _fallbackError(`no lease response in ${budget}ms`));
      }, budget);
      safety.unref?.();
    };
    armSafety();
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
