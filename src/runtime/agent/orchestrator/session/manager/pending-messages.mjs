// Steering / pending-message queue with sync buffering and atomic persistence.
import { join } from 'path';
import { readFileSync } from 'fs';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import { loadSession, readSessionLifecycleStateFromDisk, saveSessionAsync } from '../store.mjs';
import { ForeignPendingMessageController } from './foreign-pending-messages.mjs';
import {
    COMPLETION_NOTIFICATION_KIND,
    PENDING_MODE_PROMPT,
    PENDING_MODE_TASK_NOTIFICATION,
    _groupPendingMessageEntries,
    _mergePendingMessageEntries,
    carryLifecycleToken,
    completionExecutionId,
    completionWasDelivered,
    entryLifecycleToken,
    isCompletionNotificationEntry,
    isStaleUserInjection,
    lateDeliveryText,
    markCompletionEntry,
    modelVisiblePendingMessages,
    newPendingMessageId,
    normalizePersistedEntry,
    pendingEntryMode,
    pendingMessageId,
    pendingMessageQueueEntry,
    stampLifecycleToken,
} from './pending-message-entry.mjs';

export {
    COMPLETION_NOTIFICATION_KIND,
    PENDING_MODE_PROMPT,
    PENDING_MODE_TASK_NOTIFICATION,
    _groupPendingMessageEntries,
    _mergePendingMessageEntries,
    markCompletionEntry,
    pendingEntryMode,
};

const _sessionPendingMessages = new Map();
// Persisted entries are claimed once, asynchronously, when askSession takes
// ownership of a session. Hot-path drains consume this in-memory snapshot and
// never touch the global spool (or its cross-process lock).
const _hydratedPendingMessages = new Map();
const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;
const PENDING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_ORPHAN_GRACE_MS = 60 * 60 * 1000;
const _pendingPersistBuffers = new Map();
const _pendingPersistTails = new Map();
const _inDeliveryPendingIds = new Map();
const _ackedPendingIds = new Map();
const _pendingHydrations = new Map();
// Claim ledger for the in-delivery ids: the exact entries a drain handed to a
// turn. A drain consumes the not-yet-flushed persist buffer, so without this
// copy a failed turn could release ids whose payload exists nowhere (memory,
// spool, replay) any more. Claims are dropped on ack (delivered) or on
// release (restored below). A release may only restore while the session
// record still accepts pending state — a tombstoned session refuses it however
// old the claim is.
const _claimedPendingMessages = new Map();
let _pendingPersistImmediate = null;
// Authoritative pending-state lifecycle gate. The DURABLE record is the only
// authority: readSessionLifecycleStateFromDisk reports absence / open / closed
// / unreadable straight from disk, bypassing every live/pending snapshot, so a
// stale open live copy (e.g. an id under _droppedSaveIds) can never mask a
// tombstone. Only an explicit create/reopen/new-generation record — never an
// ordinary enqueue — makes a session writable again.
//   'absent'     → never saved: open and writable (generation 0)
//   'open'       → durable record at this generation
//   'closed'     → tombstone: refuses every write
//   'unreadable' → IO error / malformed / foreign record: FAIL CLOSED, and a
//                  live snapshot may only ADD refusal, never open it
function pendingSessionLifecycle(sessionId) {
    let disk = null;
    try { disk = readSessionLifecycleStateFromDisk(sessionId); } catch { disk = null; }
    const state = disk?.state;
    if (state === 'open' || state === 'closed') {
        return { source: state, closed: state === 'closed', generation: Number(disk.generation) || 0 };
    }
    if (state === 'absent') return { source: 'absent', closed: false, generation: 0 };
    // Unreadable/corrupt/foreign (or the read itself threw): never writable.
    return { source: 'unreadable', closed: true, generation: 0 };
}

// Epoch token: the exact lifecycle a claim/enqueue/hydration was taken under.
function pendingLifecycleToken(lifecycle) {
    return `${lifecycle.source}:${lifecycle.generation}`;
}

function currentPendingLifecycleToken(sessionId) {
    return pendingLifecycleToken(pendingSessionLifecycle(sessionId));
}

// Pure epoch comparison against an already-read lifecycle (no IO), so a caller
// that judges many entries reads the durable record once.
function lifecycleTokenStale(now, sinceToken) {
    if (sinceToken === null || sinceToken === undefined) return false;
    const separator = String(sinceToken).indexOf(':');
    const sinceSource = String(sinceToken).slice(0, separator);
    const sinceGeneration = Number(String(sinceToken).slice(separator + 1)) || 0;
    // Only close/detach moves the durable generation, so a differing one means
    // the session was closed/detached/reopened since: refuse.
    if (now.generation !== sinceGeneration) return true;
    // A record that was DURABLE at claim/hydration start must still be durable:
    // an unreadable record must never be mistaken for an open session. The
    // reverse (never-saved → first durable save at the same generation) is the
    // ordinary lifecycle of a fresh session and stays valid.
    if (sinceSource === 'open' && now.source !== 'open') return true;
    return false;
}

// True when pending state for this session must NOT be (re)created/published:
// tombstoned, or the durable lifecycle epoch moved since `sinceToken`.
function pendingLifecycleInvalidated(sessionId, sinceToken = null) {
    const now = pendingSessionLifecycle(sessionId);
    if (now.closed) return true;
    return lifecycleTokenStale(now, sinceToken);
}

// Epoch check for DESTRUCTIVE spool/ledger mutations (ack, prune, clear,
// foreign drain). Deliberately tombstone-TOLERANT: deleting the rows of the
// epoch that just closed is legitimate (the close path itself does it), while
// a generation move — the reopened/detached owner taking over — means those
// rows are no longer ours to touch. Callers re-evaluate this INSIDE the spool
// transaction, immediately before mutating.
function pendingLifecycleEpochMoved(sessionId, sinceToken = null) {
    if (sinceToken === null || sinceToken === undefined) return false;
    const now = pendingSessionLifecycle(sessionId);
    const separator = String(sinceToken).indexOf(':');
    const sinceGeneration = Number(String(sinceToken).slice(separator + 1)) || 0;
    if (now.generation !== sinceGeneration) return true;
    // An unreadable/foreign record is never authority for a deletion.
    if (now.source === 'unreadable') return true;
    return false;
}

function pendingIdSet(map, sessionId) {
    let ids = map.get(sessionId);
    if (!ids) {
        ids = new Set();
        map.set(sessionId, ids);
    }
    return ids;
}

// Ledger hygiene: an id set only exists while it actually suppresses ids.
// Read paths (hydrate, release, ack) must never MATERIALIZE an empty set —
// those accumulated one pair of dead Sets per resumable session and were
// pruned only by an explicit session close.
function pruneEmptyPendingIdSet(map, sessionId) {
    const ids = map.get(sessionId);
    if (ids && ids.size === 0) map.delete(sessionId);
}

function pendingMessagesPath() {
    return join(resolvePluginData(), PENDING_MESSAGES_FILE);
}

// Exposed for live-share owners: they fs.watch this file for instant pickup
// of cross-surface submits (the 3s drain tick remains the safety net).
export function pendingMessagesSpoolPath() {
    return pendingMessagesPath();
}

// Single spool transaction shape: every mutation of the shared file is locked,
// compact and non-fsync; `extra` only ever relaxes the lock timeout.
function updateSpool(mutate, extra = null) {
    return updateJsonAtomic(pendingMessagesPath(), mutate, {
        compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false, ...extra,
    });
}

// Publish a session's queue inside a spool transaction. An emptied queue drops
// the session row AND its touch stamp instead of persisting an empty array.
function setSpoolQueue(next, sessionId, kept) {
    if (kept.length > 0) { next.sessions[sessionId] = kept; return; }
    delete next.sessions[sessionId];
    if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
}

// Serialize one session's spool operations: the op becomes this session's tail
// and removes itself once settled (never clobbering a newer tail).
function chainSpoolTail(sessionId, operation, onSettled = null) {
    _pendingPersistTails.set(sessionId, operation);
    operation.finally(() => {
        if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
        onSettled?.();
    }).catch(() => {});
    return operation;
}

function pendingWarn(message) {
    try { process.stderr.write(message); } catch { /* best-effort */ }
}

function isValidPendingSessionId(sessionId) {
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function isTuiSteeringPendingKey(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('tui_');
}

function normalizeTuiSteeringQueueEntry(entry) {
    if (typeof entry === 'string') {
        const text = entry.trim();
        return text || null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const rawText = typeof entry.text === 'string'
        ? entry.text
        : (typeof entry.message === 'string'
            ? entry.message
            : (typeof entry.content === 'string' ? entry.content : ''));
    if (rawText.trim()) {
        const text = rawText.trim();
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
        if (!id) return text;
        const normalized = {
            id,
            text,
            message: text,
            enqueuedAt: Number(entry.enqueuedAt) || Date.now(),
        };
        return entry.notificationKind === COMPLETION_NOTIFICATION_KIND
            ? {
                ...normalized,
                notificationKind: COMPLETION_NOTIFICATION_KIND,
                ...(completionExecutionId(entry) ? { executionId: completionExecutionId(entry) } : {}),
            }
            : normalized;
    }
    return null;
}

function normalizePendingStore(raw) {
    const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
        ? raw.sessions
        : {};
    const storeUpdatedAt = Number(raw?.updatedAt) || Date.now();
    const touchedRaw = raw && typeof raw === 'object' && raw.sessionTouchedAt && typeof raw.sessionTouchedAt === 'object'
        ? raw.sessionTouchedAt
        : {};
    const out = { version: 1, updatedAt: storeUpdatedAt, sessions: {}, sessionTouchedAt: {} };
    for (const [sid, value] of Object.entries(sessions)) {
        if (!isValidPendingSessionId(sid) || !Array.isArray(value)) continue;
        // Persisted rows are canonical {id, …} objects (persistPendingMessages
        // normalizes at write time); anything else is dropped, not migrated.
        const q = isTuiSteeringPendingKey(sid)
            ? value.map(normalizeTuiSteeringQueueEntry).filter(Boolean)
            : value.filter((entry) => entry && typeof entry === 'object' && pendingMessageId(entry))
                .map((entry) => normalizePersistedEntry(entry)).filter(Boolean);
        if (q.length > 0) {
            out.sessions[sid] = q;
            const touched = Number(touchedRaw[sid]);
            out.sessionTouchedAt[sid] = Number.isFinite(touched) && touched > 0 ? touched : storeUpdatedAt;
        }
    }
    return out;
}

function touchPendingSessionEntry(next, sessionId, now = Date.now()) {
    if (!next.sessionTouchedAt || typeof next.sessionTouchedAt !== 'object') next.sessionTouchedAt = {};
    next.sessionTouchedAt[sessionId] = now;
}

function persistPendingMessages(sessionId, messages) {
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
        // Durable commit window: re-read the lifecycle INSIDE the spool lock.
        // A cross-process close/detach between acceptance and this commit must
        // drop the old-generation input without touching the new owner's rows.
        const committable = persistedMessages.filter((entry) => !pendingLifecycleInvalidated(
            sessionId,
            entryLifecycleToken(entry),
        ));
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
    return Boolean(handle)
        && _pendingStateHandles.get(sessionId) === handle
        && handle.epoch === epoch;
}

function trimPendingStateHandles() {
    if (_pendingStateHandles.size <= PENDING_STATE_HANDLE_LIMIT) return;
    for (const [sid, handle] of _pendingStateHandles) {
        if (_pendingStateHandles.size <= PENDING_STATE_HANDLE_LIMIT) break;
        if (handle.inFlight > 0 || _pendingPersistRetryTimers.has(sid)) continue;
        _pendingStateHandles.delete(sid);
    }
}

function bumpPendingStateEpoch(sessionId) {
    pendingStateHandle(sessionId).epoch += 1;
    trimPendingStateHandles();
}

function cancelPendingPersistRetry(sessionId, { resetBackoff = false } = {}) {
    const timer = _pendingPersistRetryTimers.get(sessionId);
    if (timer) { try { clearTimeout(timer); } catch { /* best-effort */ } }
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
    const delay = Math.min(PERSIST_RETRY_MAX_MS, PERSIST_RETRY_BASE_MS * (2 ** (attempts - 1)));
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
    if (attempts > PERSIST_RETRY_REF_ATTEMPTS) { try { timer.unref?.(); } catch { /* ignore */ } }
    _pendingPersistRetryTimers.set(sessionId, timer);
}

function flushPendingMessagePersistsSync() {
    if (_pendingPersistImmediate) {
        try { clearImmediate(_pendingPersistImmediate); } catch {}
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

function schedulePendingMessagePersist(sessionId, message) {
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

function takeBufferedPendingMessages(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    const buffered = _pendingPersistBuffers.get(sessionId);
    if (!buffered || buffered.length === 0) return [];
    _pendingPersistBuffers.delete(sessionId);
    return buffered.slice();
}

function claimPendingEntries(sessionId, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const currentToken = currentPendingLifecycleToken(sessionId);
    const prior = _claimedPendingMessages.get(sessionId);
    // Claims are stamped with the lifecycle epoch observed at claim time; a
    // claim from an older epoch is stale and never merges into the new one.
    const claims = prior && prior.token === currentToken ? prior : { token: currentToken, entries: new Map() };
    for (const entry of entries) {
        const id = pendingMessageId(entry);
        if (!id) continue;
        // The token also rides on the delivered entry OBJECT: a later claim or
        // ack may replace/remove this session's map state, and the old release
        // must still judge itself by the epoch it was handed.
        //
        // NEVER restamp: the token an entry was ACCEPTED under is immutable.
        // Overwriting it with the epoch current at claim time was exactly how
        // a generation-0 entry that survived a generation-1 detach got
        // legitimized (and then restored by a failed turn). Entries reaching
        // here without a token were never stamped (legacy/foreign paths) and
        // are claimed under the epoch observed now.
        if (!entryLifecycleToken(entry)) stampLifecycleToken(entry, currentToken);
        claims.entries.set(id, entry);
    }
    if (claims.entries.size > 0) _claimedPendingMessages.set(sessionId, claims);
}

function dropPendingClaims(sessionId, ids) {
    const claims = _claimedPendingMessages.get(sessionId);
    if (!claims) return;
    for (const id of ids) claims.entries.delete(id);
    if (claims.entries.size === 0) _claimedPendingMessages.delete(sessionId);
}

function pendingIdStillQueued(sessionId, id) {
    for (const map of [_sessionPendingMessages, _pendingPersistBuffers, _hydratedPendingMessages]) {
        const q = map.get(sessionId);
        if (Array.isArray(q) && q.some((entry) => pendingMessageId(entry) === id)) return true;
    }
    return false;
}

export function acknowledgePendingMessages(sessionId, deliveredEntries, options = {}) {
    const entries = Array.isArray(deliveredEntries) ? deliveredEntries : [];
    // Expected lifecycle epoch of THIS acknowledgement: the immutable token of
    // the delivered entries (explicit option for spool-sourced entries that
    // never carried one), falling back to the epoch observed right now.
    const explicitToken = typeof options?.expectedToken === 'string' && options.expectedToken
        ? options.expectedToken
        : null;
    const expectedToken = explicitToken
        || entries.map(entryLifecycleToken).find(Boolean)
        || currentPendingLifecycleToken(sessionId);
    // An entry from a DIFFERENT epoch is not part of this ack: its rows belong
    // to another owner and must not be deleted by this transaction.
    const ids = new Set(entries
        .filter((entry) => {
            const token = entryLifecycleToken(entry);
            return !token || token === expectedToken;
        })
        .map(pendingMessageId).filter(Boolean));
    if (ids.size === 0) return Promise.resolve(false);
    // The epoch already moved before we touched anything: leave the reopened
    // owner's memory, ledger and spool rows exactly as they are.
    if (pendingLifecycleEpochMoved(sessionId, expectedToken)) return Promise.resolve(false);
    // Read-only for the in-delivery ledger: only the acked set is being GROWN
    // here, so an ack for a session with no in-delivery state must not create
    // an empty Set that then lives until an explicit close.
    const inDelivery = _inDeliveryPendingIds.get(sessionId) || null;
    const acked = pendingIdSet(_ackedPendingIds, sessionId);
    for (const id of ids) { inDelivery?.delete(id); acked.add(id); }
    pruneEmptyPendingIdSet(_inDeliveryPendingIds, sessionId);
    // Delivered for good: the claim copy is no longer a recovery source.
    dropPendingClaims(sessionId, ids);
    const purgeMemory = () => {
        for (const map of [_pendingPersistBuffers, _sessionPendingMessages, _hydratedPendingMessages]) {
            const q = map.get(sessionId);
            if (!Array.isArray(q)) continue;
            const kept = q.filter((entry) => !ids.has(pendingMessageId(entry)));
            if (kept.length > 0) map.set(sessionId, kept);
            else map.delete(sessionId);
        }
    };
    purgeMemory();
    let epochMoved = false;
    const precedingPersist = _pendingPersistTails.get(sessionId) || Promise.resolve();
    const operation = precedingPersist.catch(() => {}).then(() => {
        // A failed preceding persist may have requeued after the first purge.
        // Skipped once the epoch moved: those queue entries are the new
        // owner's (a hydrate can republish the very same durable ids).
        if (!pendingLifecycleEpochMoved(sessionId, expectedToken)) purgeMemory();
        return updateSpool((raw) => {
        // Atomic re-validation: we now hold the spool lock. A generation
        // movement while we waited means the rows are the reopened owner's —
        // delete nothing and report failure so no ledger prune follows.
        if (pendingLifecycleEpochMoved(sessionId, expectedToken)) {
            epochMoved = true;
            return undefined;
        }
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
        const kept = q.filter((entry) => !ids.has(pendingMessageId(entry)));
        if (kept.length === q.length) return undefined;
        setSpoolQueue(next, sessionId, kept);
        next.updatedAt = Date.now();
        return next;
        });
    });
    _pendingPersistTails.set(sessionId, operation);
    const reported = operation.then(() => !epochMoved).catch((err) => {
        pendingWarn(`[session] pending-message ack failed sessionId=${sessionId}: ${err?.message || err}\n`);
        return false;
    }).then((ok) => {
        if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
        // Refused because the epoch moved: this ack never happened. Drop the
        // acked-id suppression again — those durable rows now belong to the
        // reopened owner and its hydrate must be able to take them.
        if (epochMoved) {
            const movedAcked = pendingIdSet(_ackedPendingIds, sessionId);
            for (const id of ids) movedAcked.delete(id);
            if (movedAcked.size === 0) _ackedPendingIds.delete(sessionId);
            return false;
        }
        // Keep the acked ids when the spool cleanup FAILED: the durable entry
        // still exists, and forgetting that it was already delivered let the
        // foreign-injection drain re-take it as a "new" cross-surface submit
        // (user saw the same message duplicated in the transcript). Retained
        // ids also keep suppressing the hydrate path; they are dropped only
        // once a later ack round actually lands.
        if (!ok) return false;
        const currentAcked = pendingIdSet(_ackedPendingIds, sessionId);
        for (const id of ids) currentAcked.delete(id);
        if (currentAcked.size === 0) _ackedPendingIds.delete(sessionId);
        return true;
    });
    return reported;
}

export function recordPendingMessageDelivery(session, deliveredEntries) {
    if (!session || !Array.isArray(deliveredEntries) || deliveredEntries.length === 0) return;
    const added = deliveredEntries.map(pendingMessageId).filter(Boolean);
    if (added.length === 0) return;
    const ledger = Array.isArray(session.deliveredPendingMessageIds)
        ? session.deliveredPendingMessageIds.filter((id) => typeof id === 'string' && id)
        : [];
    // This may temporarily exceed the nominal bound while spool cleanup is
    // failing. Never evict an ID whose durable spool copy may still exist.
    session.deliveredPendingMessageIds = [...new Set([...ledger, ...added])];
}

async function pruneCleanupConfirmedLedger(sessionId, confirmedEntries, session = null, persist = null, expectedToken = null) {
    const confirmedIds = new Set((Array.isArray(confirmedEntries) ? confirmedEntries : [])
        .map(pendingMessageId).filter(Boolean));
    if (confirmedIds.size === 0) return false;
    // Same atomic ownership rule as the spool ack: the ledger of a session
    // whose durable epoch moved belongs to the reopened owner.
    const token = expectedToken
        || (Array.isArray(confirmedEntries) ? confirmedEntries.map(entryLifecycleToken).find(Boolean) : null)
        || null;
    if (token && pendingLifecycleEpochMoved(sessionId, token)) return false;
    const target = session || loadSession(sessionId);
    if (!target) return false;
    const ledger = Array.isArray(target.deliveredPendingMessageIds)
        ? target.deliveredPendingMessageIds.filter((id) => typeof id === 'string' && id)
        : [];
    const kept = ledger.filter((id) => !confirmedIds.has(id));
    if (kept.length === ledger.length) return false;
    // Confirmed IDs need no replay protection and are removed immediately
    // (therefore bounded below any finite confirmed-ID retention cap).
    // Unconfirmed IDs are never size-evicted.
    // Re-checked immediately before the mutation: the load above is an await
    // boundary for the caller's chain.
    if (token && pendingLifecycleEpochMoved(sessionId, token)) return false;
    target.deliveredPendingMessageIds = kept;
    if (typeof persist === 'function') await persist();
    else await saveSessionAsync(target, { expectedGeneration: target.generation });
    return true;
}

export function finalizePendingMessageDelivery(session, deliveredEntries, durableSave, persistPrunedLedger) {
    const ids = new Set((Array.isArray(deliveredEntries) ? deliveredEntries : [])
        .map(pendingMessageId).filter(Boolean));
    if (!session || ids.size === 0) return Promise.resolve(false);
    // Strict durability order: ledger/session first, spool deletion second.
    // Both operations are detached from the completion tick.
    return Promise.resolve(durableSave).then(async () => {
        const cleaned = await acknowledgePendingMessages(session.id, deliveredEntries);
        if (!cleaned) return false;
        await pruneCleanupConfirmedLedger(
            session.id,
            deliveredEntries,
            session,
            persistPrunedLedger,
        );
        return true;
    });
}

export function releasePendingMessages(sessionId, deliveredEntries) {
    // Read-only lookups: a release for a session that carries no ledger state
    // must not materialize two empty Sets (they were pruned only on close).
    const inDelivery = _inDeliveryPendingIds.get(sessionId) || null;
    const acked = _ackedPendingIds.get(sessionId) || null;
    const claim = _claimedPendingMessages.get(sessionId);
    // Restoring is a WRITE of pending state: allowed only while the DURABLE
    // lifecycle is still open AND still the exact epoch THIS delivery was
    // claimed under. The token is read from the released entry itself and only
    // falls back to the map when the two agree — a newer claim/ack that
    // replaced or removed the map state can never re-open an old release.
    const claimToken = (entry) => entryLifecycleToken(entry)
        || (claim && claim.entries.has(pendingMessageId(entry)) ? claim.token : null);
    const releasedIds = [];
    const restored = [];
    for (const entry of Array.isArray(deliveredEntries) ? deliveredEntries : []) {
        const id = pendingMessageId(entry);
        if (!id) continue;
        inDelivery?.delete(id);
        releasedIds.push(id);
        // The turn did NOT deliver this input. Restore the claimed entry so it
        // is queued (and durable) again: the drain that claimed it may have
        // consumed the not-yet-flushed persist buffer, in which case clearing
        // the id alone would lose the message from memory, spool and replay.
        if (acked?.has(id)) continue;
        const token = claimToken(entry);
        // No token at all (never claimed through a drain) → fail closed.
        if (!token || pendingLifecycleInvalidated(sessionId, token)) continue;
        if (pendingIdStillQueued(sessionId, id)) continue;
        const claimed = claim?.entries.get(id) || pendingMessageQueueEntry(entry);
        if (claimed) restored.push(stampLifecycleToken(claimed, token));
    }
    if (restored.length > 0) {
        const q = _sessionPendingMessages.get(sessionId) || [];
        q.push(...restored);
        // FIFO by original enqueue time — a restored entry predates anything
        // queued while the failed turn was running.
        q.sort((a, b) => (Number(a?.enqueuedAt) || 0) - (Number(b?.enqueuedAt) || 0));
        _sessionPendingMessages.set(sessionId, q);
        // Durability: persistPendingMessages is id-idempotent, so an entry that
        // was already flushed keeps its single spool row while one that never
        // reached disk gets written now (restart replays it exactly once).
        for (const entry of restored) schedulePendingMessagePersist(sessionId, entry);
    }
    dropPendingClaims(sessionId, releasedIds);
    pruneEmptyPendingIdSet(_inDeliveryPendingIds, sessionId);
    pruneEmptyPendingIdSet(_ackedPendingIds, sessionId);
}

export function hydratePendingMessages(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return Promise.resolve(0);
    const existingHydration = _pendingHydrations.get(sessionId);
    if (existingHydration) return existingHydration;
    const hydration = (async () => {
      const precedingPersist = _pendingPersistTails.get(sessionId);
      if (precedingPersist) await precedingPersist.catch(() => {});
      let hydrated = [];
      let alreadyDelivered = [];
      let staleLedgerEntries = [];
      const ledgerSession = loadSession(sessionId);
      // Durable lifecycle epoch this hydration started under. Publishing claims the
      // durable entries into THIS process's memory, so it must be revalidated
      // after every await (spool IO, ack/prune): a close
      // (tombstone) or a close/detach generation bump in between means the
      // entries belong to the next owner, not to us. Aborting publishes
      // nothing and leaves the durable rows untouched for that owner.
      const startLifecycle = pendingSessionLifecycle(sessionId);
      const startToken = pendingLifecycleToken(startLifecycle);
      if (startLifecycle.closed) return 0;
      try {
        const deliveredLedger = new Set(ledgerSession?.deliveredPendingMessageIds || []);
        // Read-only: hydration runs on EVERY session takeover, and creating the
        // two id Sets here leaked one empty pair per resumable session (only an
        // explicit close ever pruned them). They are created below, once there
        // is an id to actually suppress.
        const inDelivery = _inDeliveryPendingIds.get(sessionId) || null;
        const acked = _ackedPendingIds.get(sessionId) || null;
        await updateSpool((raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            const spoolIds = new Set(q.map(pendingMessageId).filter(Boolean));
            // Ledger IDs only suppress matching durable spool entries. If no
            // such entry exists, cleanup was already completed (possibly just
            // before a crash) and the ledger ID is structurally stale.
            staleLedgerEntries = [...deliveredLedger]
                .filter((id) => !spoolIds.has(id))
                .map((id) => ({ id }));
            hydrated = q.filter((entry) => {
                const id = pendingMessageId(entry);
                if (id && deliveredLedger.has(id)) {
                    alreadyDelivered.push(entry);
                    return false;
                }
                if (!id || inDelivery?.has(id) || acked?.has(id)) return false;
                return true;
            });
            // Stale genuine user/steering entries DELIVER with a
            // late-delivery header instead of being silently dropped (the old
            // behavior discarded them; user report: remote/steering sends
            // silently ignored around owner restarts). Completion entries
            // keep their own resume-drop policy (drain discards them).
            for (const entry of hydrated) {
                if (!isStaleUserInjection(entry)) continue;
                if (typeof entry.message === 'string') {
                    entry.message = lateDeliveryText(entry.message, entry);
                }
            }
            // Read-only claim: durable data remains until successful delivery
            // acknowledges these exact ids. A crash here therefore redelivers.
            return undefined;
        });
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
      } catch (err) {
        pendingWarn(`[session] pending-message hydrate failed sessionId=${sessionId}: ${err?.message || err}\n`);
        return 0;
      }
      const cleanupConfirmed = staleLedgerEntries.slice();
      if (alreadyDelivered.length > 0) {
        const cleaned = await acknowledgePendingMessages(sessionId, alreadyDelivered, { expectedToken: startToken });
        if (cleaned) cleanupConfirmed.push(...alreadyDelivered);
        // Every individual cleanup await is its own window: stop before the
        // next mutation once the lifecycle moved (the remaining spool rows and
        // the ledger belong to the new owner from here on).
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
      }
      if (cleanupConfirmed.length > 0) {
        try {
            // One session save prunes both IDs whose replay spool was removed
            // now and IDs whose spool was already absent at hydration start.
            await pruneCleanupConfirmedLedger(sessionId, cleanupConfirmed, ledgerSession, null, startToken);
        } catch (err) {
            pendingWarn(`[session] pending-message ledger prune failed sessionId=${sessionId}: ${err?.message || err}\n`);
        }
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
      }
      if (hydrated.length > 0) {
        // Last revalidation: the ack/prune awaits above are another window.
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
        const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
        for (const entry of hydrated) {
            const id = pendingMessageId(entry);
            if (id) inDelivery.add(id);
            // Durable rows carry no symbol: stamp the epoch this hydration was
            // validated under, so every later clone/claim/ack judges itself by
            // that immutable token instead of the epoch current at the time.
            stampLifecycleToken(entry, startToken);
        }
        const existing = _hydratedPendingMessages.get(sessionId) || [];
        existing.push(...hydrated);
        _hydratedPendingMessages.set(sessionId, existing);
      }
      return hydrated.length;
    })();
    _pendingHydrations.set(sessionId, hydration);
    hydration.finally(() => {
        if (_pendingHydrations.get(sessionId) === hydration) _pendingHydrations.delete(sessionId);
    }).catch(() => {});
    return hydration;
}

function clearPersistedPendingMessages(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return;
    // ASYNC, chained behind this session's persist tail. The previous SYNC
    // variant self-deadlocked: closeSession ran it on the event loop while an
    // in-flight async spool op (persist/ack/hydrate) in the SAME process held
    // the lock — the sync wait starved the holder's continuations, so every
    // such race burned the full 8s lock timeout (observed as an 8s shard-child
    // stall after each one-shot session close). In-memory queues are already
    // dropped synchronously by _dropPendingMessageState; only the durable
    // spool row lags behind, exactly like the ack path.
    const preceding = _pendingPersistTails.get(sessionId) || Promise.resolve();
    // Epoch this clear was ordered under (normally the tombstone that just
    // landed). Re-validated inside the lock: a reopen/detach that moves the
    // generation while this async clear waits must leave the new owner's rows.
    const epochToken = currentPendingLifecycleToken(sessionId);
    const operation = preceding.catch(() => {}).then(() => updateSpool((raw) => {
        if (pendingLifecycleEpochMoved(sessionId, epochToken)) return undefined;
        const next = normalizePendingStore(raw);
        if (!Object.prototype.hasOwnProperty.call(next.sessions, sessionId)) return undefined;
        setSpoolQueue(next, sessionId, []);
        next.updatedAt = Date.now();
        return next;
    }))
        .catch((err) => {
            pendingWarn(`[session] pending-message clear failed sessionId=${sessionId}: ${err?.message || err}\n`);
        });
    chainSpoolTail(sessionId, operation);
}

function shouldEvictPendingSession(sessionId, ttlMs, entryTouchedAt, now = Date.now()) {
    if (isTuiSteeringPendingKey(sessionId)) {
        const entryTouch = Number(entryTouchedAt) || 0;
        if (entryTouch <= 0) return false;
        return (now - entryTouch) > ttlMs;
    }
    const session = loadSession(sessionId);
    if (session) {
        const touched = Math.max(
            Number(session.updatedAt) || 0,
            Number(session.lastHeartbeatAt) || 0,
            Number(session.createdAt) || 0,
        );
        return touched > 0 && (now - touched) > ttlMs;
    }
    const entryTouch = Number(entryTouchedAt) || 0;
    return entryTouch > 0 && (now - entryTouch) > PENDING_ORPHAN_GRACE_MS;
}

export async function sweepOrphanedPendingMessages({ ttlMs = PENDING_ORPHAN_TTL_MS } = {}) {
    const now = Date.now();
    const removed = [];
    try {
        await updateSpool((raw) => {
            const next = normalizePendingStore(raw);
            const ids = Object.keys(next.sessions);
            if (ids.length === 0) return undefined;
            for (const sid of ids) {
                const entryTouchedAt = next.sessionTouchedAt?.[sid];
                if (shouldEvictPendingSession(sid, ttlMs, entryTouchedAt, now)) {
                    setSpoolQueue(next, sid, []);
                    removed.push(sid);
                }
            }
            if (removed.length === 0) return undefined;
            next.updatedAt = now;
            return next;
        });
    } catch (err) {
        pendingWarn(`[session] pending-message sweep failed: ${err?.message || err}\n`);
        return 0;
    }
    if (removed.length > 0) {
        pendingWarn(`[session] pending-message sweep: removed ${removed.length} stale/orphan queue(s) (ttl=${Math.round(ttlMs / 86400000)}d) (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? `, +${removed.length - 5} more` : ''})\n`);
    }
    return removed.length;
}

export function enqueuePendingMessage(sessionId, message) {
    const normalized = pendingMessageQueueEntry(message);
    // Caller-provided ids are never trusted across sessions/processes.
    // Completion ids are content/execution-addressed by markCompletionEntry:
    // preserving them makes fallback retries idempotent, while genuine
    // user/steering ids remain freshly generated and session-local.
    const entry = normalized
        ? {
            ...normalized,
            id: isCompletionNotificationEntry(normalized) && normalized.id
                ? normalized.id
                : newPendingMessageId(),
        }
        : null;
    if (!sessionId || !entry) return 0;
    // A terminal task read may ACK before an async fallback enqueue settles.
    // Treat that completion as already delivered and never publish it.
    if (completionWasDelivered(entry, 'enqueue')) return 1;
    // A provider/tool completion that lands after the session was tombstoned
    // must NOT recreate memory/spool state (and never clears the tombstone):
    // only an explicit create/reopen record makes the session writable again.
    const token = currentPendingLifecycleToken(sessionId);
    if (pendingLifecycleInvalidated(sessionId)) return 0;
    stampLifecycleToken(entry, token);
    // Re-validate immediately before the memory publish: a close/detach landing
    // in this window must reject the input instead of recreating state for a
    // session the new owner already took over.
    if (pendingLifecycleInvalidated(sessionId, token)) return 0;
    if (isCompletionNotificationEntry(entry) && pendingIdStillQueued(sessionId, entry.id)) return 1;
    let q = _sessionPendingMessages.get(sessionId);
    if (!q) { q = []; _sessionPendingMessages.set(sessionId, q); }
    q.push(entry);
    const bufferedDepth = schedulePendingMessagePersist(sessionId, entry);
    return Math.max(q.length, bufferedDepth || 0);
}

/**
 * Remote-attach injection enqueue: persist a user message into the shared
 * cross-process spool WITHOUT touching this process's in-memory queues. Used
 * by a viewer surface attached to a session another live process owns — the
 * owner's injection poller (drainForeignUserInjections) picks it up there.
 * Skipping the local queues is deliberate: if this process later takes real
 * ownership of the session, a lingering local copy would double-inject.
 */
export function enqueueRemotePendingMessage(sessionId, message) {
    if (!isValidPendingSessionId(sessionId)) return 0;
    // Same durable-lifecycle authority as the local enqueue: a cross-surface
    // submit that lands after the session was closed is refused before any
    // spool mutation.
    const token = currentPendingLifecycleToken(sessionId);
    if (pendingLifecycleInvalidated(sessionId)) return 0;
    const normalized = pendingMessageQueueEntry(message);
    if (!normalized) return 0;
    // The token rides into the async spool commit, which revalidates under the
    // spool lock (see persistPendingMessages).
    if (pendingLifecycleInvalidated(sessionId, token)) return 0;
    // Preserve the viewer's submission id end-to-end. Minting a fresh id here
    // made pipe-delivered + spool-fallback twins look like two messages
    // (owner accepted the pipe copy, then re-took the spool copy).
    const preservedId = pendingMessageId(normalized) || pendingMessageId(message);
    const remoteEntry = stampLifecycleToken({
        ...normalized,
        id: (typeof preservedId === 'string' && preservedId.trim())
            ? preservedId.trim()
            : newPendingMessageId(),
    }, token);
    return persistPendingMessages(sessionId, [remoteEntry]);
}

function _foreignLocalIds(sessionId) {
    const localIds = new Set();
    for (const map of [_sessionPendingMessages, _pendingPersistBuffers, _hydratedPendingMessages]) {
        for (const entry of map.get(sessionId) || []) {
            const id = pendingMessageId(entry);
            if (id) localIds.add(id);
        }
    }
    for (const set of [_inDeliveryPendingIds.get(sessionId), _ackedPendingIds.get(sessionId)]) {
        for (const id of set || []) localIds.add(id);
    }
    // The durable delivered-ledger mirrors the hydrate path's suppression: an
    // entry whose id was recorded as delivered (but whose spool cleanup has
    // not landed yet — crash, lock contention, another process) is NOT a
    // foreign submit and must never re-inject.
    try {
        for (const id of loadSession(sessionId)?.deliveredPendingMessageIds || []) {
            if (typeof id === 'string' && id) localIds.add(id);
        }
    } catch { /* ledger unavailable — in-memory sets still guard */ }
    return localIds;
}

function addForeignInDeliveryIds(sessionId, ids) {
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    for (const id of ids) inDelivery.add(id);
}

function removeForeignInDeliveryIds(sessionId, ids) {
    const inDelivery = _inDeliveryPendingIds.get(sessionId);
    for (const id of ids) inDelivery?.delete(id);
    pruneEmptyPendingIdSet(_inDeliveryPendingIds, sessionId);
}

const foreignPendingMessages = new ForeignPendingMessageController({
    addInDeliveryIds: addForeignInDeliveryIds,
    chainSpoolTail,
    currentLifecycleToken: currentPendingLifecycleToken,
    getSpoolTail: (sessionId) => _pendingPersistTails.get(sessionId),
    isValidSessionId: isValidPendingSessionId,
    lifecycleEpochMoved: pendingLifecycleEpochMoved,
    lifecycleInvalidated: pendingLifecycleInvalidated,
    localIds: _foreignLocalIds,
    normalizeStore: normalizePendingStore,
    removeInDeliveryIds: removeForeignInDeliveryIds,
    setSpoolQueue,
    spoolPath: pendingMessagesPath,
    updateSpool,
    warn: pendingWarn,
});

// The controller parks rows before delivery so an owner crash can redeliver
// accepted input instead of losing it.
export async function drainForeignUserInjections(sessionId) {
    return foreignPendingMessages.drainUserInjections(sessionId);
}

export function drainPendingMessages(sessionId) {
    const q = _sessionPendingMessages.get(sessionId);
    const memory = q && q.length > 0 ? q.slice() : [];
    _sessionPendingMessages.delete(sessionId);
    const hydrated = _hydratedPendingMessages.get(sessionId) || [];
    _hydratedPendingMessages.delete(sessionId);
    // FIFO: takeover-hydrated disk entries predate the not-yet-flushed buffer.
    // This path is deliberately memory-only: no file lock, stat, parse, or
    // atomic rename can run in the agent-completion tick.
    const buffered = takeBufferedPendingMessages(sessionId);
    // Deferred completion/task notifications are dropped ONLY from the persisted
    // (disk/buffer) path. Those are the entries a later session resume/restart
    // would replay out-of-order into a future turn, once the in-memory queue is
    // gone — discarding them there is the deliberate owner decision.
    // Live in-memory completions (fallback/headless enqueues delivered within
    // THIS process, e.g. the idle-resume kick that surfaces the model-visible
    // body) are the intended payload and MUST survive the drain — filtering
    // them here dropped the notification entirely. On a genuine resume the
    // in-memory queue is empty, so keeping it only ever delivers live entries.
    // Genuine user/steering messages carry no marker and are kept in order in
    // both paths.
    // Drain-time belt: drop MARKED in-memory completion entries whose text hash
    // was already delivered+ACKed (TUI execution-ui) this process — those would
    // double-inject next turn. Only marked completion entries are eligible;
    // genuine user/steering entries carry no marker and are always kept.
    const deliveredIds = new Set();
    const deliveredEntries = [];
    const keepUndelivered = (entry) => {
        if (!isCompletionNotificationEntry(entry)) return true;
        const id = pendingMessageId(entry);
        if (id && deliveredIds.has(id)) return false;
        if (!completionWasDelivered(entry, 'drain')) return true;
        if (id) deliveredIds.add(id);
        deliveredEntries.push(entry);
        return false;
    };
    const memoryKept = memory.filter(keepUndelivered);
    const bufferedKept = buffered.filter(keepUndelivered);
    const tagged = [
        ...hydrated.map((entry, index) => ({ entry, source: 0, index })),
        ...bufferedKept.map((entry, index) => ({ entry, source: 1, index })),
        ...memoryKept.map((entry, index) => ({ entry, source: 2, index })),
    ];
    tagged.sort((a, b) => {
        const at = Number(a.entry?.enqueuedAt) || 0;
        const bt = Number(b.entry?.enqueuedAt) || 0;
        return at - bt || a.source - b.source || a.index - b.index;
    });
    const byId = new Map();
    for (const item of tagged) {
        const normalized = pendingMessageQueueEntry(item.entry);
        if (!normalized?.id) continue;
        // Prefer the live form for duplicate spool/buffer copies; content and id
        // are identical, but the live completion marker is authoritative.
        const prior = byId.get(normalized.id);
        if (!prior || item.source > prior.source) byId.set(normalized.id, { ...item, entry: normalized });
    }
    const ordered = [...byId.values()].sort((a, b) => {
        const at = Number(a.entry.enqueuedAt) || 0;
        const bt = Number(b.entry.enqueuedAt) || 0;
        return at - bt || a.source - b.source || a.index - b.index;
    });
    const dropped = ordered.filter(({ entry, source }) => source === 0
        && isCompletionNotificationEntry(entry))
        .map(({ entry }) => entry);
    const acknowledged = [...deliveredEntries, ...dropped];
    if (acknowledged.length > 0) acknowledgePendingMessages(sessionId, acknowledged);
    const visible = modelVisiblePendingMessages(ordered
        .filter(({ entry }) => !dropped.includes(entry))
        .map(({ entry }) => entry));
    // Epoch gate. Normalization above rebuilds every entry, but each copy
    // inherits the IMMUTABLE token the entry was accepted under. An entry from
    // an older epoch (a cross-process close/detach moved the generation while
    // it sat in memory) belongs to the previous owner: it is REJECTED here,
    // never restamped with the current epoch — which would legitimize it and
    // let a failed turn restore it into the new owner's queue.
    const lifecycleNow = pendingSessionLifecycle(sessionId);
    const accepted = [];
    let rejected = 0;
    for (const entry of visible) {
        const token = entryLifecycleToken(entry);
        if (token && (lifecycleNow.closed || lifecycleTokenStale(lifecycleNow, token))) {
            rejected += 1;
            continue;
        }
        accepted.push(entry);
    }
    if (rejected > 0) {
        pendingWarn(`[session] rejected ${rejected} queued message(s) from a superseded lifecycle epoch sessionId=${sessionId}\n`);
    }
    // Only materialize the ledger when there is an id to suppress: an empty
    // drain used to leave a dead Set behind on every call.
    const claimedIds = accepted.filter((entry) => entry.id);
    if (claimedIds.length > 0) {
        const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
        for (const entry of claimedIds) inDelivery.add(entry.id);
    }
    // Keep the exact claimed payloads until ack (delivered) or release.
    claimPendingEntries(sessionId, accepted);
    return accepted;
}

// Snapshot queued entries without draining them. Compaction uses this to keep
// sidecars referenced by a message that is waiting for the next turn, whether
// it is still in memory, buffered for persistence, or already on disk.
export function _getPendingMessagesForSession(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    const queued = [
        ...(_sessionPendingMessages.get(sessionId) || []),
        ...(_pendingPersistBuffers.get(sessionId) || []),
    ];
    let raw;
    try {
        raw = readFileSync(pendingMessagesPath(), 'utf8');
    } catch (err) {
        if (err?.code === 'ENOENT') return queued;
        throw err;
    }
    const persisted = normalizePendingStore(JSON.parse(raw)).sessions[sessionId];
    if (Array.isArray(persisted)) queued.push(...persisted);
    return queued;
}

// Cleanup hook for closeSession — drop the in-memory queue and buffered-persist
// entry so both Maps do not accumulate one entry per closed session.
export function _dropPendingMessageState(id, { clearPersisted = true } = {}) {
    // Bumped FIRST: every write already in flight now belongs to a superseded
    // state generation and may neither requeue nor re-arm a retry after this
    // teardown. The detach re-persist below runs under the NEW generation, so
    // it keeps its own retry.
    bumpPendingStateEpoch(id);
    if (!clearPersisted) {
        const buffered = _pendingPersistBuffers.get(id);
        if (buffered?.length) {
            try { persistPendingMessages(id, buffered); } catch { /* ignore */ }
        }
    }
    // Tombstoned close: the claim copies are dead (the session record itself
    // now refuses any restore). Detach keeps them so a still-in-flight ask can
    // release and restore its claimed entries after this cleanup runs.
    if (clearPersisted) {
        try { _claimedPendingMessages.delete(id); } catch { /* ignore */ }
    }
    try { _sessionPendingMessages.delete(id); } catch { /* ignore */ }
    try { _hydratedPendingMessages.delete(id); } catch { /* ignore */ }
    try { _pendingPersistBuffers.delete(id); } catch { /* ignore */ }
    try { cancelPendingPersistRetry(id, { resetBackoff: true }); } catch { /* ignore */ }
    // A tombstoned close removes the whole durable queue anyway; a DETACH keeps
    // its scheduled release so this process still cleans up rows it parked.
    if (clearPersisted) {
        try { foreignPendingMessages.cancelHandoffRelease(id); } catch { /* ignore */ }
    }
    try { _inDeliveryPendingIds.delete(id); } catch { /* ignore */ }
    try { _ackedPendingIds.delete(id); } catch { /* ignore */ }
    try { _pendingHydrations.delete(id); } catch { /* ignore */ }
    if (clearPersisted) {
        try { clearPersistedPendingMessages(id); } catch { /* ignore */ }
    }
}

/**
 * Shutdown drain (and test determinism seam): flush this module's buffered
 * persist batch and await its own async spool tails (persist / ack / clear)
 * plus in-flight hydrations, so a process may exit knowing every ACCEPTED
 * message reached the durable spool. Tails can re-chain (an ack chains behind
 * a persist), so this loops until the maps are empty, bounded by timeoutMs.
 *
 * Runtime-safe: the exit path gets a RESOLVED verdict — `true` when everything
 * settled, `false` when the budget expired (logged, never thrown), so a stuck
 * spool write can neither break nor hang a shutdown. Tests can opt into a
 * strict timeout through `throwOnTimeout`.
 *
 * @param {{ timeoutMs?: number, throwOnTimeout?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function settlePendingMessageWrites({ timeoutMs = 5000, throwOnTimeout = false } = {}) {
    try {
        await drainPendingMessageWrites(timeoutMs);
        return true;
    } catch (err) {
        if (throwOnTimeout) throw err;
        pendingWarn(`[session] pending-message shutdown drain incomplete: ${err?.message || err}\n`);
        return false;
    }
}

async function drainPendingMessageWrites(timeoutMs = 5000) {
    const budget = Math.max(0, Number(timeoutMs) || 0);
    const deadline = Date.now() + budget;
    const expired = () => new Error(
        `pending-message writes did not settle within ${budget}ms `
        + `(tails=${_pendingPersistTails.size}, hydrations=${_pendingHydrations.size}, buffers=${_pendingPersistBuffers.size})`,
    );
    let timer = null;
    const expiry = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(expired()), Math.max(0, deadline - Date.now()));
    });
    // Deliberately NOT unref'd: while settle waits on a stuck tail there may be
    // no other handle, and an unref'd timer would let the loop drain (the wait
    // would then never reject). The finally below always clears it.
    expiry.catch(() => {});
    try {
        for (;;) {
            // Snapshot BEFORE flushing: persistPendingMessages OVERWRITES this
            // session's map entry with the new operation, so an in-flight tail
            // captured only after the flush would be silently dropped and never
            // awaited. Both the pre-flush tails and the newly chained ones must
            // be awaited, and the loop repeats because acks/clears chain further
            // tails behind them.
            const preFlushTails = [..._pendingPersistTails.values()];
            flushPendingMessagePersistsSync();
            const inflight = new Set([
                ...preFlushTails,
                ..._pendingPersistTails.values(),
                ..._pendingHydrations.values(),
            ]);
            if (inflight.size === 0 && _pendingPersistBuffers.size === 0) return;
            if (Date.now() > deadline) throw expired();
            // Raced against the absolute deadline: a never-settling tail must
            // reject within timeoutMs instead of blocking here forever.
            await Promise.race([Promise.allSettled([...inflight]), expiry]);
            await Promise.race([new Promise((resolve) => setImmediate(resolve)), expiry]);
        }
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// TEST-ONLY: publish a promise as this session's persist tail using the same
// set + self-removal pattern as persistPendingMessages, so settle tests can
// model a slow (or stuck) spool write deterministically. Runtime code never
// calls this and behavior is unchanged.
export function _setPendingPersistTailForTest(sessionId, promise) {
    return chainSpoolTail(sessionId, Promise.resolve(promise).catch(() => {}));
}

setImmediate(() => {
    // Spool hygiene belongs to the lead/daemon process. Channel workers share
    // the same spool file; a boot-time SYNC sweep in every child contends on
    // the cross-process lock against the lead's writes for zero
    // benefit — the lead already sweeps.
    if (process.env.MIXDOG_WORKER_MODE === '1') return;
    void sweepOrphanedPendingMessages().catch(() => {});
});
