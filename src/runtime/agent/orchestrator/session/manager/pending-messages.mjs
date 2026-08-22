// Steering / pending-message queue with sync buffered + atomic-file persistence.
// Extracted verbatim from manager.mjs (behavior-preserving).
import { join } from 'path';
import { readFileSync } from 'fs';
import { stat } from 'fs/promises';
import { createHash, randomBytes } from 'crypto';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import { promptContentText, isInternalRuntimeNotificationText } from './prompt-utils.mjs';
import { loadSession, readSessionLifecycleStateFromDisk, saveSessionAsync } from '../store.mjs';
import { isDeliveredCompletion, logDuplicateSkip } from './delivered-completions.mjs';

const _sessionPendingMessages = new Map();
// Persisted entries are claimed once, asynchronously, when askSession takes
// ownership of a session. Hot-path drains consume this in-memory snapshot and
// never touch the global spool (or its cross-process lock).
const _hydratedPendingMessages = new Map();
const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;
const PENDING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_ORPHAN_GRACE_MS = 60 * 60 * 1000;
// Replay window for genuine user/steering entries. A cross-surface submit is
// meant for a LIVE owner; entries that predate this process and exceeded the
// window are still DELIVERED (queued user input is never silently
// discarded), but annotated with an
// explicit late-delivery header so a session resumed hours later reads them
// as clearly-late input instead of a surprise self-injection.
const STALE_USER_INJECTION_TTL_MS = 30 * 60 * 1000;

// Ownership epoch for the staleness gate below: entries enqueued while THIS
// process was already alive were aimed at a live owner that still exists.
const _PENDING_PROCESS_START_MS = Date.now();

function isStaleUserInjection(entry, now = Date.now()) {
    if (isCompletionNotificationEntry(entry)) return false;
    const enqueuedAt = Number(entry?.enqueuedAt) || 0;
    if (enqueuedAt <= 0) return false;
    // A submit that arrived AFTER this owner process booted is CURRENT input
    // the owner was merely too busy to take yet (observed: remote sends
    // silently discarded after 30m while the owner ground through long
    // turns). It must deliver regardless of age. The stale window only
    // guards entries that PREDATE this process — the resumed-session replay
    // case the TTL was built for (surprise self-injection on re-entry).
    if (enqueuedAt >= _PENDING_PROCESS_START_MS) return false;
    return (now - enqueuedAt) > STALE_USER_INJECTION_TTL_MS;
}

// Never silently discard queued user input. A stale entry is
// delivered with this explicit age-annotated header so neither the user nor
// the model mistakes it for fresh input.
function lateDeliveryText(text, entry, now = Date.now()) {
    const value = String(text ?? '');
    if (!value.trim()) return value;
    const enqueuedAt = Number(entry?.enqueuedAt) || 0;
    const ageMinutes = Math.max(1, Math.round((now - enqueuedAt) / 60000));
    const age = ageMinutes >= 120 ? `~${Math.round(ageMinutes / 60)}h` : `~${ageMinutes}m`;
    return `[late delivery: queued ${age} ago, before the current session owner started]\n${value}`;
}
// Marker for deferred agent/tool *completion* notifications. Such entries must
// never be replayed into a later turn on session resume (out-of-order delivery
// is worse than loss — owner decision), so drain discards them. Genuine
// user/steering messages carry no marker and keep full queue + replay behavior.
export const COMPLETION_NOTIFICATION_KIND = 'completion_notification';
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
// Lifecycle token stamped on the exact entry object a drain/enqueue observed.
// Symbol-keyed so it never reaches the spool (JSON.stringify ignores symbols)
// and never changes the entry's public shape.
const LIFECYCLE_TOKEN = Symbol('pendingLifecycleToken');
// Deterministic test seams for the check→mutate windows (close/detach racing
// an enqueue publish, a spool commit, or a multi-step hydrate cleanup).
let _pendingTestHooks = null;
function runPendingTestHook(name, payload) {
    const hook = _pendingTestHooks?.[name];
    if (typeof hook !== 'function') return;
    try { hook(payload); } catch { /* test seam is best-effort */ }
}

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

function stampLifecycleToken(entry, token) {
    if (!entry || typeof entry !== 'object' || !token) return entry;
    try {
        Object.defineProperty(entry, LIFECYCLE_TOKEN, {
            value: token, enumerable: false, configurable: true, writable: true,
        });
    } catch { /* frozen entry: the claim map still carries the token */ }
    return entry;
}

function entryLifecycleToken(entry) {
    const token = entry && typeof entry === 'object' ? entry[LIFECYCLE_TOKEN] : null;
    return typeof token === 'string' && token ? token : null;
}

// Clone/normalize boundary helper. Every normalized copy of an accepted entry
// MUST inherit the source entry's IMMUTABLE lifecycle token: a copy that loses
// it is later restamped with whatever epoch happens to be current, which
// legitimizes an old-generation entry (drain → claim → release/ack against a
// reopened owner). Symbols are dropped by object spread and JSON, so every
// constructor of a derived entry routes through here.
function carryLifecycleToken(target, source) {
    const token = entryLifecycleToken(source);
    return token ? stampLifecycleToken(target, token) : target;
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

function newPendingMessageId() {
    return randomBytes(12).toString('hex');
}

function pendingMessageId(entry) {
    return typeof entry?.id === 'string' && entry.id ? entry.id : null;
}

function isCompletionNotificationEntry(entry) {
    return Boolean(entry) && typeof entry === 'object'
        && entry.notificationKind === COMPLETION_NOTIFICATION_KIND;
}

function completionExecutionId(entry) {
    const value = typeof entry?.executionId === 'string' ? entry.executionId.trim() : '';
    return value || null;
}

function completionWasDelivered(entry, site) {
    if (!isCompletionNotificationEntry(entry)) return false;
    const executionId = completionExecutionId(entry);
    const text = pendingMessageText(entry);
    if (!isDeliveredCompletion({ executionId, text })) return false;
    logDuplicateSkip(site, { executionId, text });
    return true;
}

// Canonical completion-enqueue tagger. Every deferred tool/agent completion
// notification MUST be enqueued through this so drain can discard it on resume
// (never replay out-of-order). Pass the model-visible completion text (or an
// existing entry); genuine user/steering messages must NOT be tagged.
export function markCompletionEntry(text, options = {}) {
    const value = typeof text === 'string'
        ? text
        : (text && typeof text === 'object' ? (text.text || text.content || '') : '');
    const content = String(value ?? '');
    const executionId = String(options?.executionId || '').trim();
    const identity = executionId ? `execution:${executionId}` : `content:${content}`;
    const id = `completion_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    return {
        id,
        content,
        text: content,
        notificationKind: COMPLETION_NOTIFICATION_KIND,
        ...(executionId ? { executionId } : {}),
        enqueuedAt: Date.now(),
    };
}

function pendingMessagesPath() {
    return join(resolvePluginData(), PENDING_MESSAGES_FILE);
}

// Exposed for live-share owners: they fs.watch this file for instant pickup
// of cross-surface submits (the 3s drain tick remains the safety net).
export function pendingMessagesSpoolPath() {
    return pendingMessagesPath();
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

function normalizePendingMessageEntry(entry) {
    if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? { content: text, text } : null;
    }
    if (Array.isArray(entry)) {
        if (entry.length === 0) return null;
        const text = promptContentText(entry).trim();
        return { content: entry, text };
    }
    if (!entry || typeof entry !== 'object') return null;
    const identity = {
        id: pendingMessageId(entry),
        enqueuedAt: Number(entry.enqueuedAt) || Date.now(),
    };
    const entryOptions = entry.options && typeof entry.options === 'object'
        ? { options: entry.options }
        : {};
    const marker = entry.notificationKind === COMPLETION_NOTIFICATION_KIND
        ? {
            notificationKind: COMPLETION_NOTIFICATION_KIND,
            ...(completionExecutionId(entry) ? { executionId: completionExecutionId(entry) } : {}),
            enqueuedAt: Number(entry.enqueuedAt) || Date.now(),
        }
        : null;
    const content = Object.prototype.hasOwnProperty.call(entry, 'content')
        ? entry.content
        : (typeof entry.message === 'string'
            ? entry.message
            : (typeof entry.text === 'string' ? entry.text : null));
    if (content == null) return null;
    const text = typeof entry.text === 'string' ? entry.text.trim() : promptContentText(content).trim();
    let out = null;
    if (Array.isArray(content)) out = content.length > 0 ? { content, text, ...entryOptions } : null;
    else if (typeof content === 'string') {
        const value = content.trim();
        out = value ? { content: value, text: text || value, ...entryOptions } : null;
    } else {
        const fallback = promptContentText(content).trim();
        out = fallback ? { content: fallback, text: text || fallback, ...entryOptions } : null;
    }
    if (!out) return null;
    // The lifecycle token rides along every derived copy (see carryLifecycleToken).
    return carryLifecycleToken(marker ? { ...out, ...identity, ...marker } : { ...out, ...identity }, entry);
}

function pendingMessageText(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    return normalized ? String(normalized.text || promptContentText(normalized.content) || '').trim() : '';
}

function pendingMessageQueueEntry(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    if (!normalized) return null;
    const identity = {
        id: normalized.id || newPendingMessageId(),
        enqueuedAt: Number(normalized.enqueuedAt) || Date.now(),
    };
    const marker = isCompletionNotificationEntry(normalized)
        ? {
            notificationKind: COMPLETION_NOTIFICATION_KIND,
            ...(completionExecutionId(normalized) ? { executionId: completionExecutionId(normalized) } : {}),
            enqueuedAt: normalized.enqueuedAt,
        }
        : null;
    const base = {
        ...identity,
        content: normalized.content,
        text: normalized.text || promptContentText(normalized.content).trim(),
        ...(normalized.options ? { options: normalized.options } : {}),
    };
    return carryLifecycleToken(marker ? { ...base, ...marker } : base, entry);
}

// Canonical persisted-queue entry: an {id, message|content, enqueuedAt}
// object, plus a notificationKind marker for completion/task notifications so
// the marker survives an on-disk round trip. Accepts an in-memory queue entry
// (string | content/text object) and normalizes it for the spool.
function normalizePersistedEntry(entry) {
    if (typeof entry === 'string') {
        const message = entry.trim();
        return message ? {
            id: newPendingMessageId(),
            message,
            enqueuedAt: Date.now(),
        } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const id = pendingMessageId(entry) || newPendingMessageId();
    const enqueuedAt = Number(entry.enqueuedAt) || Date.now();
    if (isCompletionNotificationEntry(entry)) {
        const message = (typeof entry.message === 'string' && entry.message.trim())
            ? entry.message.trim()
            : pendingMessageText(entry);
        return message
            ? {
                id,
                message,
                notificationKind: COMPLETION_NOTIFICATION_KIND,
                ...(completionExecutionId(entry) ? { executionId: completionExecutionId(entry) } : {}),
                enqueuedAt,
            }
            : null;
    }
    if (typeof entry.message === 'string') {
        const message = entry.message.trim();
        return message ? { id, message, enqueuedAt } : null;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'content')) {
        const normalized = normalizePendingMessageEntry(entry);
        if (!normalized) return null;
        if (typeof normalized.content === 'string' && !normalized.options) {
            return { id, message: normalized.text || normalized.content, enqueuedAt };
        }
        return {
            id,
            content: normalized.content,
            text: normalized.text,
            ...(normalized.options ? { options: normalized.options } : {}),
            enqueuedAt,
        };
    }
    const t = pendingMessageText(entry);
    return t ? { id, message: t, enqueuedAt } : null;
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
    // Async lock wait: this runs on the lead/TUI main process (tool-exec +
    // steering persist). withFileLock waits off the event loop, so cross-
    // process contention on the shared spool never freezes the renderer.
    // Best-effort: the returned promise is fire-and-forget; depth is reported
    // optimistically from the buffered batch length.
    const operation = updateJsonAtomic(pendingMessagesPath(), (raw) => {
        // Durable commit window: re-read the lifecycle INSIDE the spool lock.
        // A cross-process close/detach between acceptance and this commit must
        // drop the old-generation input without touching the new owner's rows.
        runPendingTestHook('persist:beforeCommit', { sessionId });
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
    }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false })
        .catch((err) => {
            try { process.stderr.write(`[session] pending-message persist failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
            // Requeue on failure (lock timeout/contention): buffered messages
            // were already cleared by the flush, so push them back so the next
            // scheduled flush or session takeover retries instead of losing them.
            try {
                const acked = pendingIdSet(_ackedPendingIds, sessionId);
                const q = _pendingPersistBuffers.get(sessionId) || [];
                q.push(...persistedMessages.filter((entry) => !acked.has(pendingMessageId(entry))));
                _pendingPersistBuffers.set(sessionId, q);
            } catch {}
        });
    _pendingPersistTails.set(sessionId, operation);
    operation.finally(() => {
        if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
    }).catch(() => {});
    return persistedMessages.length;
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
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    const acked = pendingIdSet(_ackedPendingIds, sessionId);
    for (const id of ids) { inDelivery.delete(id); acked.add(id); }
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
        return updateJsonAtomic(pendingMessagesPath(), (raw) => {
        // Atomic re-validation: we now hold the spool lock. A generation
        // movement while we waited means the rows are the reopened owner's —
        // delete nothing and report failure so no ledger prune follows.
        runPendingTestHook('ack:beforeCommit', { sessionId });
        if (pendingLifecycleEpochMoved(sessionId, expectedToken)) {
            epochMoved = true;
            return undefined;
        }
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
        const kept = q.filter((entry) => !ids.has(pendingMessageId(entry)));
        const removed = q.length - kept.length;
        if (removed === 0) return undefined;
        if (kept.length > 0) next.sessions[sessionId] = kept;
        else {
            delete next.sessions[sessionId];
            if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
        }
        next.updatedAt = Date.now();
        return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    });
    _pendingPersistTails.set(sessionId, operation);
    const reported = operation.then(() => !epochMoved).catch((err) => {
        try { process.stderr.write(`[session] pending-message ack failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
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
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    const acked = pendingIdSet(_ackedPendingIds, sessionId);
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
        inDelivery.delete(id);
        releasedIds.push(id);
        // The turn did NOT deliver this input. Restore the claimed entry so it
        // is queued (and durable) again: the drain that claimed it may have
        // consumed the not-yet-flushed persist buffer, in which case clearing
        // the id alone would lose the message from memory, spool and replay.
        if (acked.has(id)) continue;
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
    if (inDelivery.size === 0) _inDeliveryPendingIds.delete(sessionId);
}

export function hydratePendingMessages(sessionId, options = {}) {
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
      // after every await (spool IO, test beforePublish, ack/prune): a close
      // (tombstone) or a close/detach generation bump in between means the
      // entries belong to the next owner, not to us. Aborting publishes
      // nothing and leaves the durable rows untouched for that owner.
      const startLifecycle = pendingSessionLifecycle(sessionId);
      const startToken = pendingLifecycleToken(startLifecycle);
      if (startLifecycle.closed) return 0;
      try {
        const deliveredLedger = new Set(ledgerSession?.deliveredPendingMessageIds || []);
        const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
        const acked = pendingIdSet(_ackedPendingIds, sessionId);
        await updateJsonAtomic(pendingMessagesPath(), (raw) => {
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
                if (!id || inDelivery.has(id) || acked.has(id)) return false;
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
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
        await options.beforePublish?.(hydrated);
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
      } catch (err) {
        try { process.stderr.write(`[session] pending-message hydrate failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
        return 0;
      }
      const cleanupConfirmed = staleLedgerEntries.slice();
      if (alreadyDelivered.length > 0) {
        const cleaned = await acknowledgePendingMessages(sessionId, alreadyDelivered, { expectedToken: startToken });
        if (cleaned) cleanupConfirmed.push(...alreadyDelivered);
        // Every individual cleanup await is its own window: stop before the
        // next mutation once the lifecycle moved (the remaining spool rows and
        // the ledger belong to the new owner from here on).
        runPendingTestHook('hydrate:betweenCleanups', { sessionId });
        if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
      }
      if (cleanupConfirmed.length > 0) {
        try {
            // One session save prunes both IDs whose replay spool was removed
            // now and IDs whose spool was already absent at hydration start.
            await pruneCleanupConfirmedLedger(sessionId, cleanupConfirmed, ledgerSession, null, startToken);
        } catch (err) {
            try { process.stderr.write(`[session] pending-message ledger prune failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
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
    const operation = preceding.catch(() => {}).then(() => updateJsonAtomic(pendingMessagesPath(), (raw) => {
        if (pendingLifecycleEpochMoved(sessionId, epochToken)) return undefined;
        const next = normalizePendingStore(raw);
        if (!Object.prototype.hasOwnProperty.call(next.sessions, sessionId)) return undefined;
        delete next.sessions[sessionId];
        if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
        next.updatedAt = Date.now();
        return next;
    }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false }))
        .catch((err) => {
            try { process.stderr.write(`[session] pending-message clear failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
        });
    _pendingPersistTails.set(sessionId, operation);
    operation.finally(() => {
        if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
    }).catch(() => {});
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
        await updateJsonAtomic(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const ids = Object.keys(next.sessions);
            if (ids.length === 0) return undefined;
            for (const sid of ids) {
                const entryTouchedAt = next.sessionTouchedAt?.[sid];
                if (shouldEvictPendingSession(sid, ttlMs, entryTouchedAt, now)) {
                    delete next.sessions[sid];
                    if (next.sessionTouchedAt) delete next.sessionTouchedAt[sid];
                    removed.push(sid);
                }
            }
            if (removed.length === 0) return undefined;
            next.updatedAt = now;
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message sweep failed: ${err?.message || err}\n`); } catch {}
        return 0;
    }
    if (removed.length > 0) {
        try {
            process.stderr.write(
                `[session] pending-message sweep: removed ${removed.length} stale/orphan queue(s) (ttl=${Math.round(ttlMs / 86400000)}d) (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? `, +${removed.length - 5} more` : ''})\n`,
            );
        } catch { /* ignore */ }
    }
    return removed.length;
}

function modelVisiblePendingMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map(pendingMessageQueueEntry)
        .filter(Boolean)
        .filter((message) => !isInternalRuntimeNotificationText(
            message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'content')
                ? message.content
                : message,
        ));
}

export function _mergePendingMessageEntries(entries) {
    // Delivery priority: user input enqueues at 'next', task notifications at
    // 'later', and dequeue always serves 'next' first. Our single merged turn
    // message is the
    // analogue of that dequeue order: genuine user/steering entries are
    // merged BEFORE deferred completion notifications so queued user input
    // is never buried under system notification text. FIFO is preserved
    // within each group (stable partition).
    const source = Array.isArray(entries) ? entries : [];
    const ordered = [
        ...source.filter((entry) => !isCompletionNotificationEntry(entry)),
        ...source.filter(isCompletionNotificationEntry),
    ];
    const normalized = ordered
        .map(normalizePendingMessageEntry)
        .filter(Boolean);
    if (normalized.length === 0) return null;
    const displayText = normalized.map((entry) => entry.text || promptContentText(entry.content))
        .filter((text) => String(text || '').trim())
        .join('\n');
    if (normalized.every((entry) => typeof entry.content === 'string')) {
        return {
            content: normalized.map((entry) => entry.content).filter(Boolean).join('\n'),
            text: displayText,
            count: normalized.length,
        };
    }
    const parts = [];
    for (const entry of normalized) {
        if (typeof entry.content === 'string') {
            if (entry.content.trim()) parts.push({ type: 'text', text: entry.content });
        } else if (Array.isArray(entry.content)) {
            parts.push(...entry.content);
        } else {
            const text = promptContentText(entry.content);
            if (text.trim()) parts.push({ type: 'text', text });
        }
        parts.push({ type: 'text', text: '\n' });
    }
    while (parts.length && parts[parts.length - 1]?.type === 'text' && parts[parts.length - 1]?.text === '\n') parts.pop();
    return { content: parts, text: displayText || promptContentText(parts), count: normalized.length };
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
    runPendingTestHook('enqueue:beforePublish', { sessionId });
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
    runPendingTestHook('enqueue:beforePublish', { sessionId });
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

// Spool-file mtime gate so the owner's idle poller costs one stat per tick,
// not a locked read-modify-write. Keyed PER SESSION: one process can own
// several sessions (desktop tabs, TUI + engine hosts) and a single shared
// counter let the first drain of a tick swallow the mtime bump for every
// other session, stranding their foreign submits until the next spool write.
const FOREIGN_SPOOL_SCAN_LIMIT = Math.max(
    128,
    Number(process.env.MIXDOG_FOREIGN_SPOOL_SCAN_LIMIT) || 512,
);
const _foreignSpoolScanMtimes = new Map();
const _foreignDrainRequests = new Map();
let _foreignDrainScheduled = false;
let _foreignDrainRunning = false;

function _rememberForeignSpoolScan(sessionId, mtime) {
    _foreignSpoolScanMtimes.delete(sessionId);
    _foreignSpoolScanMtimes.set(sessionId, mtime);
    while (_foreignSpoolScanMtimes.size > FOREIGN_SPOOL_SCAN_LIMIT) {
        const oldest = _foreignSpoolScanMtimes.keys().next().value;
        if (oldest === undefined) break;
        _foreignSpoolScanMtimes.delete(oldest);
    }
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

function _settleForeignDrain(request, value) {
    for (const resolve of request.waiters) {
        try { resolve(value); } catch { /* a consumer cannot break the batch */ }
    }
}

function _scheduleForeignDrainBatch() {
    if (_foreignDrainScheduled || _foreignDrainRunning || _foreignDrainRequests.size === 0) return;
    _foreignDrainScheduled = true;
    setImmediate(() => {
        _foreignDrainScheduled = false;
        void _flushForeignDrainBatch();
    });
}

async function _flushForeignDrainBatch() {
    if (_foreignDrainRunning) return;
    _foreignDrainRunning = true;
    const batch = [..._foreignDrainRequests.values()];
    _foreignDrainRequests.clear();
    try {
        let mtime = 0;
        try { mtime = (await stat(pendingMessagesPath())).mtimeMs || 0; }
        catch {
            for (const request of batch) _settleForeignDrain(request, []);
            return;
        }
        const candidates = batch.filter((request) =>
            _foreignSpoolScanMtimes.get(request.sessionId) !== mtime
            && !pendingLifecycleInvalidated(request.sessionId, request.epochToken));
        for (const request of batch) {
            if (!candidates.includes(request)) _settleForeignDrain(request, []);
        }
        if (candidates.length === 0) return;
        for (const request of candidates) {
            request.localIds = _foreignLocalIds(request.sessionId);
            request.taken = [];
            request.lifecycleDecided = false;
        }
        await updateJsonAtomic(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            let changed = false;
            for (const request of candidates) {
                const { sessionId, epochToken, localIds, taken } = request;
                // Same authority re-read INSIDE the spool lock: a close/detach
                // landing in this window must neither deliver to the old owner
                // nor remove the reopened owner's rows.
                runPendingTestHook('foreignDrain:beforeCommit', { sessionId });
                if (pendingLifecycleInvalidated(sessionId, epochToken)) continue;
                request.lifecycleDecided = true;
                const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
                if (q.length === 0) continue;
                const kept = [];
                for (const entry of q) {
                    const id = pendingMessageId(entry);
                    const text = pendingMessageText(entry);
                    const foreignUser = id && !localIds.has(id)
                        && !isCompletionNotificationEntry(entry)
                        && text && !isInternalRuntimeNotificationText(text);
                    const normalized = normalizePendingMessageEntry(entry);
                    const structured = Array.isArray(normalized?.content) || Boolean(normalized?.options);
                    if (foreignUser && isStaleUserInjection(entry)) {
                        const lateText = lateDeliveryText(text, entry);
                        const content = Array.isArray(normalized?.content)
                            ? [{ type: 'text', text: `${lateText.slice(0, lateText.length - text.length)}` }, ...normalized.content]
                            : lateText;
                        taken.push({
                            ...(structured ? { content } : {}),
                            text: lateText,
                            id,
                            ...(normalized?.options ? { options: normalized.options } : {}),
                        });
                    } else if (foreignUser) {
                        taken.push({
                            ...(structured ? { content: normalized?.content ?? text } : {}),
                            text,
                            id,
                            ...(normalized?.options ? { options: normalized.options } : {}),
                        });
                    } else {
                        kept.push(entry);
                    }
                }
                if (taken.length === 0) continue;
                changed = true;
                if (kept.length > 0) next.sessions[sessionId] = kept;
                else {
                    delete next.sessions[sessionId];
                    if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
                }
            }
            if (!changed) return undefined;
            next.updatedAt = Date.now();
            return next;
        }, {
            compact: true,
            lock: true,
            mode: PENDING_MESSAGES_MODE,
            fsync: false,
            // Delivery polling must never wait behind a spool writer. A later
            // fs.watch/poll tick retries unchanged requests.
            timeoutMs: 0,
        });
        for (const request of candidates) {
            if (request.lifecycleDecided) _rememberForeignSpoolScan(request.sessionId, mtime);
            _settleForeignDrain(request, request.taken);
        }
    } catch (err) {
        if (err?.code !== 'ELOCKCONTENDED') {
            try { process.stderr.write(`[session] foreign-injection drain failed: ${err?.message || err}\n`); } catch {}
        }
        for (const request of batch) {
            if (request.waiters.length > 0) _settleForeignDrain(request, []);
        }
    } finally {
        _foreignDrainRunning = false;
        _scheduleForeignDrainBatch();
    }
}

/**
 * Owner-side drain of FOREIGN user injections for a session this process
 * owns: atomically removes (and returns the text of) genuine user/steering
 * entries that were persisted by ANOTHER process — entries known locally
 * (own steering buffers, hydrated, in-delivery, acked) and completion/
 * internal-notification entries are left untouched for the normal
 * askSession hydrate path.
 */
export async function drainForeignUserInjections(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    // DELIVERY path, not cleanup: this takes rows out of the spool and hands
    // them to a live turn. A tombstoned (or otherwise invalidated) session may
    // neither receive nor lose input, so the tombstone-TOLERANT epoch check
    // used by the explicit cleanup mutations (ack / clear) is wrong here — the
    // token is refused outright when it was captured from a closed session.
    // Checked BEFORE the mtime memo so a later reopen still sees this spool
    // state as unscanned.
    const epochToken = currentPendingLifecycleToken(sessionId);
    if (pendingLifecycleInvalidated(sessionId)) return [];
    return new Promise((resolve) => {
        const existing = _foreignDrainRequests.get(sessionId);
        if (existing && existing.epochToken === epochToken) {
            existing.waiters.push(resolve);
        } else {
            if (existing) _settleForeignDrain(existing, []);
            _foreignDrainRequests.set(sessionId, {
                sessionId,
                epochToken,
                waiters: [resolve],
                localIds: null,
                taken: [],
                lifecycleDecided: false,
            });
        }
        _scheduleForeignDrainBatch();
    });
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
        try {
            process.stderr.write(
                `[session] rejected ${rejected} queued message(s) from a superseded lifecycle epoch sessionId=${sessionId}\n`,
            );
        } catch { /* best-effort */ }
    }
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    for (const entry of accepted) if (entry.id) inDelivery.add(entry.id);
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
    try {
        const persisted = normalizePendingStore(JSON.parse(raw)).sessions[sessionId];
        if (Array.isArray(persisted)) queued.push(...persisted);
    } catch (err) {
        throw err;
    }
    return queued;
}

// Cleanup hook for closeSession — drop the in-memory queue and buffered-persist
// entry so both Maps do not accumulate one entry per closed session.
export function _dropPendingMessageState(id, { clearPersisted = true } = {}) {
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
    try { _inDeliveryPendingIds.delete(id); } catch { /* ignore */ }
    try { _ackedPendingIds.delete(id); } catch { /* ignore */ }
    try { _pendingHydrations.delete(id); } catch { /* ignore */ }
    if (clearPersisted) {
        try { clearPersistedPendingMessages(id); } catch { /* ignore */ }
    }
}

// TEST-ONLY determinism seam (never called by runtime code): flush this
// module's own buffered persist batch and await its own async spool tails
// (persist / ack / clear) and in-flight hydrations, so tests can wait for the
// asynchronous persistence tail instead of guessing a sleep duration. Tails
// can re-chain (an ack chains behind a persist), so this loops until the maps
// are empty, bounded by timeoutMs — a genuinely stuck write still fails loudly
// instead of hanging forever.
export async function _settlePendingMessageWrites({ timeoutMs = 5000 } = {}) {
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
    const operation = Promise.resolve(promise).catch(() => {});
    _pendingPersistTails.set(sessionId, operation);
    operation.finally(() => {
        if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
    }).catch(() => {});
    return operation;
}

// TEST-ONLY: deterministic seams for the check→mutate windows. Runtime code
// never installs hooks; behavior is unchanged when none are set.
//   'enqueue:beforePublish'    — between the lifecycle check and the memory /
//                                spool publish of a local/remote enqueue
//   'persist:beforeCommit'     — inside the spool lock, before the durable
//                                commit re-validates each entry's token
//   'ack:beforeCommit'         — inside the spool lock, before the ack
//                                re-validates its epoch and deletes rows
//   'hydrate:betweenCleanups'  — after each acknowledgement/prune await
export function _setPendingTestHooks(hooks) {
    _pendingTestHooks = hooks && typeof hooks === 'object' ? hooks : null;
    return _pendingTestHooks;
}

setImmediate(() => {
    // Spool hygiene belongs to the lead/daemon process. Channel workers share
    // the same spool file; a boot-time SYNC sweep in every child contends on
    // the cross-process lock against the lead's writes for zero
    // benefit — the lead already sweeps.
    if (process.env.MIXDOG_WORKER_MODE === '1') return;
    void sweepOrphanedPendingMessages().catch(() => {});
});
