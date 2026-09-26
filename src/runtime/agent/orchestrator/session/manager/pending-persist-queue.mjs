// Durability lane for accepted pending messages: the in-memory persist buffer,
// the locked spool commit each batch performs, the failure requeue with its
// backoff retry, and the (identity, epoch) state handles that keep a late
// failure from resurrecting state a close/detach already tore down.
import {
  chainSpoolTail,
  isValidPendingSessionId,
  normalizePendingStore,
  pendingWarn,
  touchPendingSessionEntry,
  updateSpool,
} from './pending-spool-file.mjs';
import { pendingLifecycleInvalidated } from './pending-lifecycle-epoch.mjs';
import { _ackedPendingIds } from './pending-claim-ledger.mjs';
import {
  entryLifecycleToken,
  normalizePersistedEntry,
  pendingMessageId,
  stampLifecycleToken,
} from './pending-message-entry.mjs';

export const _pendingPersistBuffers = new Map();
let _pendingPersistImmediate = null;

export function persistPendingMessages(sessionId, messages) {
  if (!isValidPendingSessionId(sessionId)) return 0;
  const sourceMessages = Array.isArray(messages) ? messages : [messages];
  const persistedMessages = sourceMessages
    .map((entry) => {
      const normalized = normalizePersistedEntry(entry);
      if (!normalized) return null;
      // Carry the lifecycle token observed when this entry was accepted
      // so the commit below can drop it if the session moved on.
      const token = entryLifecycleToken(entry);
      return token ? stampLifecycleToken(normalized, token) : normalized;
    })
    .filter(Boolean);
  if (persistedMessages.length === 0) return 0;
  // State handle this write belongs to: a close/detach landing while the
  // spool op is in flight invalidates its failure requeue AND its retry. The
  // in-flight count also pins the handle against the size trim, so the
  // capture below stays comparable however many other sessions churn.
  const stateHandle = pendingStateHandle(sessionId);
  const stateEpoch = stateHandle.epoch;
  stateHandle.inFlight += 1;
  // Async lock wait: this runs on the lead/TUI main process (tool-exec +
  // steering persist). withFileLock waits off the event loop, so cross-
  // process contention on the shared spool never freezes the renderer.
  // Best-effort: the returned promise is fire-and-forget; depth is reported
  // optimistically from the buffered batch length.
  const operation = updateSpool((raw) => {
    // Close fence, INSIDE the spool lock: a close/detach that tore this
    // session's pending state down while the write waited for the lock owns
    // the spool from here on — the superseded write may not land after it.
    if (!pendingStateUnchanged(sessionId, stateHandle, stateEpoch)) return undefined;
    // Durable commit window: re-read the lifecycle INSIDE the spool lock.
    // A cross-process close/detach between acceptance and this commit must
    // drop the old-generation input without touching the new owner's rows.
    const committable = persistedMessages.filter(
      (entry) => !pendingLifecycleInvalidated(sessionId, entryLifecycleToken(entry))
    );
    if (committable.length === 0) return undefined;
    const next = normalizePendingStore(raw);
    const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
    // Idempotent by id: a restored claim (releasePendingMessages) may be
    // durable already, and re-appending it would leave two spool rows for
    // one queued input (double replay after a restart).
    const existingIds = new Set(q.map(pendingMessageId).filter(Boolean));
    const additions = committable.filter((entry) => {
      const id = pendingMessageId(entry);
      if (id && existingIds.has(id)) return false;
      if (id) existingIds.add(id);
      return true;
    });
    if (additions.length === 0) return undefined;
    q.push(...additions);
    next.sessions[sessionId] = q;
    const now = Date.now();
    next.updatedAt = now;
    touchPendingSessionEntry(next, sessionId, now);
    return next;
  })
    .then((result) => {
      // Landed: forget the failure backoff so the next transient error
      // starts from the short delay again.
      _pendingPersistRetryAttempts.delete(sessionId);
      return result;
    })
    .catch((err) => {
      pendingWarn(`[session] pending-message persist failed sessionId=${sessionId}: ${err?.message || err}\n`);
      // Requeue on failure (lock timeout/contention): buffered messages
      // were already cleared by the flush, so push them back — AND
      // schedule the retry HERE. Waiting for "the next scheduled flush or
      // session takeover" meant a FINAL submit (nothing else ever
      // enqueues afterwards) stayed process-local forever, while
      // enqueue/enqueueRemotePendingMessage had already reported success.
      try {
        // Closed/detached since this write started: its buffer and its
        // retry timer were torn down on purpose — do not rebuild them.
        if (!pendingStateUnchanged(sessionId, stateHandle, stateEpoch)) return;
        const acked = _ackedPendingIds.get(sessionId);
        const q = _pendingPersistBuffers.get(sessionId) || [];
        q.push(...persistedMessages.filter((entry) => !acked?.has(pendingMessageId(entry))));
        _pendingPersistBuffers.set(sessionId, q);
        if (q.length > 0) schedulePendingPersistRetry(sessionId, stateHandle, stateEpoch);
      } catch {}
    });
  // onSettled runs AFTER the requeue decision above, so the handle stays
  // pinned for exactly as long as this write can still act on it.
  chainSpoolTail(sessionId, operation, () => {
    stateHandle.inFlight = Math.max(0, stateHandle.inFlight - 1);
    trimPendingStateHandles();
  });
  return persistedMessages.length;
}

// Automatic retry for a FAILED durable commit. The failure path requeues the
// batch into _pendingPersistBuffers; nothing else in this module ever moved it
// again on its own, so transient lock contention on the shared spool could
// strand accepted user input in process memory until the process exited.
// Backoff is exponential and capped; the first attempts keep the event loop
// alive (finishing a user message is real work), later ones are unref'd so a
// permanently unwritable spool can never pin a shutting-down process.
const PERSIST_RETRY_BASE_MS = 25;
const PERSIST_RETRY_MAX_MS = 2000;
const PERSIST_RETRY_REF_ATTEMPTS = 3;
const PENDING_STATE_HANDLE_LIMIT = 512;
const _pendingPersistRetryTimers = new Map();
const _pendingPersistRetryAttempts = new Map();
// Per-session state handle, bumped by _dropPendingMessageState. An async
// persist that FAILS after a close/detach must not resurrect the retry timer
// (and the requeued buffer) that the close just tore down — the retry loop
// would then outlive the session forever.
//
// The fence is an (identity, epoch) PAIR, not a bare counter: a size-trimmed
// counter map hands an evicted session back its DEFAULT generation, so a stale
// capture from before the close compares equal again (ABA) and resurrects.
// Object identity cannot be recreated by eviction, and a handle with a write
// in flight or a retry armed is never evicted — so trimming can neither
// confuse a stale capture nor discard a live requeue.
const _pendingStateHandles = new Map();

function pendingStateHandle(sessionId) {
  let handle = _pendingStateHandles.get(sessionId);
  if (!handle) {
    handle = { epoch: 0, inFlight: 0 };
    _pendingStateHandles.set(sessionId, handle);
  }
  return handle;
}

// True while the (identity, epoch) pair a write captured is still this
// session's live pending state.
function pendingStateUnchanged(sessionId, handle, epoch) {
  return Boolean(handle) && _pendingStateHandles.get(sessionId) === handle && handle.epoch === epoch;
}

function trimPendingStateHandles() {
  if (_pendingStateHandles.size <= PENDING_STATE_HANDLE_LIMIT) return;
  for (const [sid, handle] of _pendingStateHandles) {
    if (_pendingStateHandles.size <= PENDING_STATE_HANDLE_LIMIT) break;
    if (handle.inFlight > 0 || _pendingPersistRetryTimers.has(sid)) continue;
    _pendingStateHandles.delete(sid);
  }
}

export function bumpPendingStateEpoch(sessionId) {
  pendingStateHandle(sessionId).epoch += 1;
  trimPendingStateHandles();
}

export function cancelPendingPersistRetry(sessionId, { resetBackoff = false } = {}) {
  const timer = _pendingPersistRetryTimers.get(sessionId);
  if (timer) {
    try {
      clearTimeout(timer);
    } catch {
      /* best-effort */
    }
  }
  _pendingPersistRetryTimers.delete(sessionId);
  if (resetBackoff) _pendingPersistRetryAttempts.delete(sessionId);
}

function schedulePendingPersistRetry(sessionId, stateHandle, stateEpoch) {
  if (!isValidPendingSessionId(sessionId)) return;
  // The session state this retry belongs to is gone (closed/detached).
  if (!pendingStateUnchanged(sessionId, stateHandle, stateEpoch)) return;
  if (_pendingPersistRetryTimers.has(sessionId)) return;
  const attempts = (_pendingPersistRetryAttempts.get(sessionId) || 0) + 1;
  _pendingPersistRetryAttempts.set(sessionId, attempts);
  const delay = Math.min(PERSIST_RETRY_MAX_MS, PERSIST_RETRY_BASE_MS * 2 ** (attempts - 1));
  const timer = setTimeout(() => {
    _pendingPersistRetryTimers.delete(sessionId);
    // Re-checked at fire time: a close between arming and firing wins.
    if (!pendingStateUnchanged(sessionId, stateHandle, stateEpoch)) {
      _pendingPersistRetryAttempts.delete(sessionId);
      return;
    }
    const buffered = _pendingPersistBuffers.get(sessionId);
    if (!buffered || buffered.length === 0) {
      _pendingPersistRetryAttempts.delete(sessionId);
      return;
    }
    _pendingPersistBuffers.delete(sessionId);
    try {
      persistPendingMessages(sessionId, buffered);
    } catch {
      // A synchronous throw must not drop the batch either.
      const q = _pendingPersistBuffers.get(sessionId) || [];
      q.push(...buffered);
      _pendingPersistBuffers.set(sessionId, q);
      schedulePendingPersistRetry(sessionId, stateHandle, stateEpoch);
    }
  }, delay);
  if (attempts > PERSIST_RETRY_REF_ATTEMPTS) {
    try {
      timer.unref?.();
    } catch {
      /* ignore */
    }
  }
  _pendingPersistRetryTimers.set(sessionId, timer);
}

export function flushPendingMessagePersistsSync() {
  if (_pendingPersistImmediate) {
    try {
      clearImmediate(_pendingPersistImmediate);
    } catch {}
    _pendingPersistImmediate = null;
  }
  if (_pendingPersistBuffers.size === 0) return;
  const batches = [..._pendingPersistBuffers.entries()];
  _pendingPersistBuffers.clear();
  for (const [sid, messages] of batches) {
    // This flush now owns the batch: a still-armed retry timer would only
    // re-flush an empty buffer.
    cancelPendingPersistRetry(sid);
    persistPendingMessages(sid, messages);
  }
}

export function schedulePendingMessagePersist(sessionId, message) {
  if (!isValidPendingSessionId(sessionId)) return 0;
  const persistedMessage = normalizePersistedEntry(message);
  if (!persistedMessage) return 0;
  const token = entryLifecycleToken(message);
  if (token) stampLifecycleToken(persistedMessage, token);
  const q = _pendingPersistBuffers.get(sessionId) || [];
  q.push(persistedMessage);
  _pendingPersistBuffers.set(sessionId, q);
  if (!_pendingPersistImmediate) {
    _pendingPersistImmediate = setImmediate(() => {
      _pendingPersistImmediate = null;
      flushPendingMessagePersistsSync();
    });
  }
  return q.length;
}

export function takeBufferedPendingMessages(sessionId) {
  if (!isValidPendingSessionId(sessionId)) return [];
  const buffered = _pendingPersistBuffers.get(sessionId);
  if (!buffered || buffered.length === 0) return [];
  _pendingPersistBuffers.delete(sessionId);
  return buffered.slice();
}
