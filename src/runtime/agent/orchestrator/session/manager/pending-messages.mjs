// Steering / pending-message queue with sync buffered + atomic-file persistence.
// Extracted verbatim from manager.mjs (behavior-preserving).
import { join } from 'path';
import { readFileSync, statSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { updateJsonAtomicSync, updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import { promptContentText, isInternalRuntimeNotificationText } from './prompt-utils.mjs';
import { loadSession, saveSessionAsync } from '../store.mjs';
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
let _pendingPersistImmediate = null;

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

function legacyPendingMessageId(sessionId, index, value) {
    return `legacy_${createHash('sha256').update(`${sessionId}:${index}:${value}`).digest('hex').slice(0, 24)}`;
}

function isCompletionNotificationEntry(entry) {
    return Boolean(entry) && typeof entry === 'object'
        && entry.notificationKind === COMPLETION_NOTIFICATION_KIND;
}

// Pre-marker completion notifications were persisted as plain strings,
// indistinguishable from genuine user/steering messages except by their
// model-visible wrapper shape. Such stale strings must never replay into a
// resumed session, but they carry no notificationKind marker, so the marker
// check alone leaves them behind. Because this is a SILENT-drop path, the
// shared lenient wrapper detector is too broad (a user message quoting a
// completion card could be dropped), so this uses its OWN strict recognizer:
// the string must be a verbatim full-card paste and nothing else —
//   (1) start with the exact instruction preamble + "\n\nResult:\n",
//   (2) have EVERY non-empty body line quoted with "> " (100%),
//   (3) carry no extra leading/trailing prose (whitespace-trim only).
// Conservative by design: a false negative just keeps a legacy string, but a
// false positive on genuine user text would silently drop a real message.
const LEGACY_COMPLETION_CARD_PREAMBLE_RE = /^The async \S+ task \S+ has finished \([^)]*\) - review this result in your next step\.\n\nResult:\n/;
function isLegacyUnmarkedCompletionNotification(entry) {
    if (typeof entry !== 'string') return false;
    const value = entry.trim();
    const match = LEGACY_COMPLETION_CARD_PREAMBLE_RE.exec(value);
    if (!match) return false;
    const body = value.slice(match[0].length);
    const lines = body.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return false;
    return lines.every((line) => line.startsWith('> '));
}

// Canonical completion-enqueue tagger. Every deferred tool/agent completion
// notification MUST be enqueued through this so drain can discard it on resume
// (never replay out-of-order). Pass the model-visible completion text (or an
// existing entry); genuine user/steering messages must NOT be tagged.
export function markCompletionEntry(text) {
    const value = typeof text === 'string'
        ? text
        : (text && typeof text === 'object' ? (text.text || text.content || '') : '');
    const content = String(value ?? '');
    return { content, text: content, notificationKind: COMPLETION_NOTIFICATION_KIND, enqueuedAt: Date.now() };
}

function pendingMessagesPath() {
    return join(resolvePluginData(), PENDING_MESSAGES_FILE);
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
            ? { ...normalized, notificationKind: COMPLETION_NOTIFICATION_KIND }
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
        const q = isTuiSteeringPendingKey(sid)
            ? value.map(normalizeTuiSteeringQueueEntry).filter(Boolean)
            : value.map((entry, index) => normalizePersistedEntry(entry, {
                legacyId: legacyPendingMessageId(sid, index, typeof entry === 'string' ? entry : JSON.stringify(entry)),
                fallbackEnqueuedAt: storeUpdatedAt + index,
            })).filter(Boolean);
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
    const marker = entry.notificationKind === COMPLETION_NOTIFICATION_KIND
        ? { notificationKind: COMPLETION_NOTIFICATION_KIND, enqueuedAt: Number(entry.enqueuedAt) || Date.now() }
        : null;
    const content = Object.prototype.hasOwnProperty.call(entry, 'content')
        ? entry.content
        : (typeof entry.message === 'string'
            ? entry.message
            : (typeof entry.text === 'string' ? entry.text : null));
    if (content == null) return null;
    const text = typeof entry.text === 'string' ? entry.text.trim() : promptContentText(content).trim();
    let out = null;
    if (Array.isArray(content)) out = content.length > 0 ? { content, text } : null;
    else if (typeof content === 'string') {
        const value = content.trim();
        out = value ? { content: value, text: text || value } : null;
    } else {
        const fallback = promptContentText(content).trim();
        out = fallback ? { content: fallback, text: text || fallback } : null;
    }
    if (!out) return null;
    return marker ? { ...out, ...identity, ...marker } : { ...out, ...identity };
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
        ? { notificationKind: COMPLETION_NOTIFICATION_KIND, enqueuedAt: normalized.enqueuedAt }
        : null;
    const base = { ...identity, content: normalized.content, text: normalized.text || promptContentText(normalized.content).trim() };
    return marker ? { ...base, ...marker } : base;
}

// Canonical persisted-queue entry: a plain string for user/steering messages,
// or a { message, notificationKind, enqueuedAt } object for completion/task
// notifications so the marker survives an on-disk round trip. Accepts either an
// in-memory queue entry (content/text) or an already-persisted entry
// (string | { message } legacy | marked object); back-compatible with both.
function normalizePersistedEntry(entry, options = {}) {
    if (typeof entry === 'string') {
        const message = entry.trim();
        return message ? {
            id: options.legacyId || newPendingMessageId(),
            message,
            enqueuedAt: Number(options.fallbackEnqueuedAt) || Date.now(),
        } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const id = pendingMessageId(entry) || options.legacyId || newPendingMessageId();
    const enqueuedAt = Number(entry.enqueuedAt) || Number(options.fallbackEnqueuedAt) || Date.now();
    if (isCompletionNotificationEntry(entry)) {
        const message = (typeof entry.message === 'string' && entry.message.trim())
            ? entry.message.trim()
            : pendingMessageText(entry);
        return message
            ? { id, message, notificationKind: COMPLETION_NOTIFICATION_KIND, enqueuedAt }
            : null;
    }
    if (typeof entry.message === 'string') {
        const message = entry.message.trim();
        return message ? { id, message, enqueuedAt } : null;
    }
    const t = pendingMessageText(entry);
    return t ? { id, message: t, enqueuedAt } : null;
}

function persistPendingMessages(sessionId, messages) {
    if (!isValidPendingSessionId(sessionId)) return 0;
    const persistedMessages = (Array.isArray(messages) ? messages : [messages])
        .map(normalizePersistedEntry)
        .filter(Boolean);
    if (persistedMessages.length === 0) return 0;
    // Async lock wait: this runs on the lead/TUI main process (tool-exec +
    // steering persist). withFileLock waits off the event loop, so cross-
    // process contention on the shared spool never freezes the renderer.
    // Best-effort: the returned promise is fire-and-forget; depth is reported
    // optimistically from the buffered batch length.
    const operation = updateJsonAtomic(pendingMessagesPath(), (raw) => {
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
        q.push(...persistedMessages);
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

export function acknowledgePendingMessages(sessionId, deliveredEntries) {
    const ids = new Set((Array.isArray(deliveredEntries) ? deliveredEntries : [])
        .map(pendingMessageId).filter(Boolean));
    if (ids.size === 0) return Promise.resolve(false);
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    const acked = pendingIdSet(_ackedPendingIds, sessionId);
    for (const id of ids) { inDelivery.delete(id); acked.add(id); }
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
    const precedingPersist = _pendingPersistTails.get(sessionId) || Promise.resolve();
    const operation = precedingPersist.catch(() => {}).then(() => {
        // A failed preceding persist may have requeued after the first purge.
        purgeMemory();
        return updateJsonAtomic(pendingMessagesPath(), (raw) => {
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
    const reported = operation.then(() => true).catch((err) => {
        try { process.stderr.write(`[session] pending-message ack failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
        return false;
    }).finally(() => {
        const currentAcked = pendingIdSet(_ackedPendingIds, sessionId);
        for (const id of ids) currentAcked.delete(id);
        if (currentAcked.size === 0) _ackedPendingIds.delete(sessionId);
        if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
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

async function pruneCleanupConfirmedLedger(sessionId, confirmedEntries, session = null, persist = null) {
    const confirmedIds = new Set((Array.isArray(confirmedEntries) ? confirmedEntries : [])
        .map(pendingMessageId).filter(Boolean));
    if (confirmedIds.size === 0) return false;
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
    for (const entry of Array.isArray(deliveredEntries) ? deliveredEntries : []) {
        const id = pendingMessageId(entry);
        if (id) inDelivery.delete(id);
    }
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
                return id && !inDelivery.has(id) && !acked.has(id);
            });
            // Read-only claim: durable data remains until successful delivery
            // acknowledges these exact ids. A crash here therefore redelivers.
            return undefined;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
        await options.beforePublish?.(hydrated);
      } catch (err) {
        try { process.stderr.write(`[session] pending-message hydrate failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
        return 0;
      }
      const cleanupConfirmed = staleLedgerEntries.slice();
      if (alreadyDelivered.length > 0) {
        const cleaned = await acknowledgePendingMessages(sessionId, alreadyDelivered);
        if (cleaned) cleanupConfirmed.push(...alreadyDelivered);
      }
      if (cleanupConfirmed.length > 0) {
        try {
            // One session save prunes both IDs whose replay spool was removed
            // now and IDs whose spool was already absent at hydration start.
            await pruneCleanupConfirmedLedger(sessionId, cleanupConfirmed, ledgerSession);
        } catch (err) {
            try { process.stderr.write(`[session] pending-message ledger prune failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
        }
      }
      if (hydrated.length > 0) {
        const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
        for (const entry of hydrated) {
            const id = pendingMessageId(entry);
            if (id) inDelivery.add(id);
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
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            if (!Object.prototype.hasOwnProperty.call(next.sessions, sessionId)) return undefined;
            delete next.sessions[sessionId];
            if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
            next.updatedAt = Date.now();
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message clear failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
    }
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

export function sweepOrphanedPendingMessages({ ttlMs = PENDING_ORPHAN_TTL_MS } = {}) {
    const now = Date.now();
    const removed = [];
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
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
    const normalized = (Array.isArray(entries) ? entries : [])
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
    const entry = normalized ? { ...normalized, id: newPendingMessageId() } : null;
    if (!sessionId || !entry) return 0;
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
    const normalized = pendingMessageQueueEntry(message);
    if (!normalized) return 0;
    return persistPendingMessages(sessionId, [{ ...normalized, id: newPendingMessageId() }]);
}

// Spool-file mtime gate so the owner's idle poller costs one stat per tick,
// not a locked read-modify-write.
let _foreignSpoolScanMtime = 0;

/**
 * Owner-side drain of FOREIGN user injections for a session this process
 * owns: atomically removes (and returns the text of) genuine user/steering
 * entries that were persisted by ANOTHER process — entries known locally
 * (own steering buffers, hydrated, in-delivery, acked) and completion/
 * internal-notification entries are left untouched for the normal
 * askSession hydrate path.
 */
export function drainForeignUserInjections(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    let mtime = 0;
    try { mtime = statSync(pendingMessagesPath()).mtimeMs || 0; } catch { return []; }
    if (mtime === _foreignSpoolScanMtime) return [];
    _foreignSpoolScanMtime = mtime;
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
    const taken = [];
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            if (q.length === 0) return undefined;
            const kept = [];
            for (const entry of q) {
                const id = pendingMessageId(entry);
                const text = pendingMessageText(entry);
                const foreignUser = id && !localIds.has(id)
                    && !isCompletionNotificationEntry(entry)
                    && !isLegacyUnmarkedCompletionNotification(text)
                    && text && !isInternalRuntimeNotificationText(text);
                if (foreignUser) taken.push(text);
                else kept.push(entry);
            }
            if (taken.length === 0) return undefined;
            if (kept.length > 0) next.sessions[sessionId] = kept;
            else {
                delete next.sessions[sessionId];
                if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
            }
            next.updatedAt = Date.now();
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] foreign-injection drain failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
        return [];
    }
    return taken;
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
    const memoryKept = memory.filter((m) => {
        if (!isCompletionNotificationEntry(m)) return true;
        const text = pendingMessageText(m);
        if (text && isDeliveredCompletion({ text })) {
            logDuplicateSkip('drain', { text });
            return false;
        }
        return true;
    });
    const tagged = [
        ...hydrated.map((entry, index) => ({ entry, source: 0, index })),
        ...buffered.map((entry, index) => ({ entry, source: 1, index })),
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
        && (isCompletionNotificationEntry(entry) || isLegacyUnmarkedCompletionNotification(pendingMessageText(entry))))
        .map(({ entry }) => entry);
    if (dropped.length > 0) acknowledgePendingMessages(sessionId, dropped);
    const visible = modelVisiblePendingMessages(ordered
        .filter(({ entry }) => !dropped.includes(entry))
        .map(({ entry }) => entry));
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    for (const entry of visible) if (entry.id) inDelivery.add(entry.id);
    return visible;
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

setImmediate(() => {
    try { sweepOrphanedPendingMessages(); } catch { /* ignore */ }
});
