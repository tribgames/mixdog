// Steering / pending-message queue with sync buffered + atomic-file persistence.
// Extracted verbatim from manager.mjs (behavior-preserving).
import { join } from 'path';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { updateJsonAtomicSync } from '../../../../shared/atomic-file.mjs';
import { promptContentText, isInternalRuntimeNotificationText } from './prompt-utils.mjs';

const _sessionPendingMessages = new Map();
const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;
const _pendingPersistBuffers = new Map();
let _pendingPersistImmediate = null;

function pendingMessagesPath() {
    return join(resolvePluginData(), PENDING_MESSAGES_FILE);
}

function isValidPendingSessionId(sessionId) {
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function normalizePendingStore(raw) {
    const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
        ? raw.sessions
        : {};
    const out = { version: 1, updatedAt: Date.now(), sessions: {} };
    for (const [sid, value] of Object.entries(sessions)) {
        if (!isValidPendingSessionId(sid) || !Array.isArray(value)) continue;
        const q = value
            .map((entry) => {
                if (typeof entry === 'string') return entry;
                if (entry && typeof entry === 'object' && typeof entry.message === 'string') return entry.message;
                return '';
            })
            .filter(Boolean);
        if (q.length > 0) out.sessions[sid] = q;
    }
    return out;
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
    let depth = 0;
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            q.push(...persistedMessages);
            next.sessions[sessionId] = q;
            next.updatedAt = Date.now();
            depth = q.length;
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message persist failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
    }
    return depth;
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
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            drained = q.filter((m) => typeof m === 'string' && m.length > 0);
            if (drained.length === 0) return undefined;
            delete next.sessions[sessionId];
            next.updatedAt = Date.now();
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message drain failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
    }
    return drained;
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
    const persisted = [...takeBufferedPendingMessages(sessionId), ...drainPersistedPendingMessages(sessionId)];
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
export function _dropPendingMessageState(id) {
    try { _sessionPendingMessages.delete(id); } catch { /* ignore */ }
    try { _pendingPersistBuffers.delete(id); } catch { /* ignore */ }
}
