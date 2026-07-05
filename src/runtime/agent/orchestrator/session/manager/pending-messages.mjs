// Steering / pending-message queue with sync buffered + atomic-file persistence.
// Extracted verbatim from manager.mjs (behavior-preserving).
import { join } from 'path';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { updateJsonAtomicSync, updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import { promptContentText, isInternalRuntimeNotificationText } from './prompt-utils.mjs';
import { loadSession } from '../store.mjs';

const _sessionPendingMessages = new Map();
const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;
const PENDING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_ORPHAN_GRACE_MS = 60 * 60 * 1000;
const _pendingPersistBuffers = new Map();
let _pendingPersistImmediate = null;

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
    if (typeof entry.text === 'string' && entry.text.trim()) {
        const text = entry.text.trim();
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
        return id ? { id, text } : text;
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
            : value
                .map((entry) => {
                    if (typeof entry === 'string') return entry;
                    if (entry && typeof entry === 'object' && typeof entry.message === 'string') return entry.message;
                    return '';
                })
                .filter(Boolean);
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
    const content = Object.prototype.hasOwnProperty.call(entry, 'content') ? entry.content : null;
    if (content == null) return null;
    const text = typeof entry.text === 'string' ? entry.text.trim() : promptContentText(content).trim();
    if (Array.isArray(content)) return content.length > 0 ? { content, text } : null;
    if (typeof content === 'string') {
        const value = content.trim();
        return value ? { content: value, text: text || value } : null;
    }
    const fallback = promptContentText(content).trim();
    return fallback ? { content: fallback, text: text || fallback } : null;
}

function pendingMessageText(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    return normalized ? String(normalized.text || promptContentText(normalized.content) || '').trim() : '';
}

function pendingMessageQueueEntry(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    if (!normalized) return null;
    if (typeof normalized.content === 'string' && normalized.content === normalized.text) return normalized.content;
    return { content: normalized.content, text: normalized.text || promptContentText(normalized.content).trim() };
}

function persistPendingMessages(sessionId, messages) {
    if (!isValidPendingSessionId(sessionId)) return 0;
    const persistedMessages = (Array.isArray(messages) ? messages : [messages])
        .map(pendingMessageText)
        .filter(Boolean);
    if (persistedMessages.length === 0) return 0;
    // Async lock wait: this runs on the lead/TUI main process (tool-exec +
    // steering persist). withFileLock waits off the event loop, so cross-
    // process contention on the shared spool never freezes the renderer.
    // Best-effort: the returned promise is fire-and-forget; depth is reported
    // optimistically from the buffered batch length.
    updateJsonAtomic(pendingMessagesPath(), (raw) => {
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
                const q = _pendingPersistBuffers.get(sessionId) || [];
                q.push(...persistedMessages);
                _pendingPersistBuffers.set(sessionId, q);
            } catch {}
        });
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
    const persistedMessage = pendingMessageText(message);
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

function drainPersistedPendingMessages(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    let drained = [];
    try {
        // Sync drain: called synchronously by drainPendingMessages, whose
        // return value is spread immediately. Kept sync (updateJsonAtomicSync)
        // so ordering/return contract is preserved; this fires only at
        // session takeover, not on the keystroke/turn hot path.
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            drained = q.filter((m) => typeof m === 'string' && m.length > 0);
            if (drained.length === 0) return undefined;
            delete next.sessions[sessionId];
            if (next.sessionTouchedAt) delete next.sessionTouchedAt[sessionId];
            next.updatedAt = Date.now();
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message drain failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
    }
    return drained;
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
    const entry = pendingMessageQueueEntry(message);
    if (!sessionId || !entry) return 0;
    let q = _sessionPendingMessages.get(sessionId);
    if (!q) { q = []; _sessionPendingMessages.set(sessionId, q); }
    q.push(entry);
    const bufferedDepth = schedulePendingMessagePersist(sessionId, entry);
    return Math.max(q.length, bufferedDepth || 0);
}

export function drainPendingMessages(sessionId) {
    const q = _sessionPendingMessages.get(sessionId);
    const memory = q && q.length > 0 ? q.slice() : [];
    _sessionPendingMessages.delete(sessionId);
    // FIFO: disk-persisted entries were flushed before the not-yet-flushed
    // in-memory persist buffer, so they are strictly older — drain them
    // first. Reversing this order (buffer before disk) delivered newer
    // buffered sends ahead of older persisted ones after a restart.
    const persisted = [...drainPersistedPendingMessages(sessionId), ...takeBufferedPendingMessages(sessionId)];
    const memoryVisible = modelVisiblePendingMessages(memory);
    const persistedVisible = modelVisiblePendingMessages(persisted);
    if (memoryVisible.length === 0) return persistedVisible;
    if (persistedVisible.length === 0) return memoryVisible;
    const persistedTexts = persistedVisible.map(pendingMessageText);
    const prefixMatches = memoryVisible.every((m, i) => persistedTexts[i] === pendingMessageText(m));
    if (prefixMatches) return [...memoryVisible, ...persistedVisible.slice(memoryVisible.length)];
    const out = persistedVisible.slice();
    const seen = new Set(persistedTexts);
    for (const m of memoryVisible) {
        const text = pendingMessageText(m);
        if (!text || seen.has(text)) continue;
        out.push(m);
        seen.add(text);
    }
    return out;
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
    try { _pendingPersistBuffers.delete(id); } catch { /* ignore */ }
    if (clearPersisted) {
        try { clearPersistedPendingMessages(id); } catch { /* ignore */ }
    }
}

setImmediate(() => {
    try { sweepOrphanedPendingMessages(); } catch { /* ignore */ }
});
