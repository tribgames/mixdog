/**
 * Session summary index: the compact `session-summaries.json` sidecar that
 * lists every session's lightweight metadata (preview, counts, lifecycle) so
 * the status aggregator and session listers avoid parsing every full session
 * file. Extracted from store.mjs verbatim; store.mjs re-exports these so
 * importers stay unchanged.
 */
import { mkdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { updateJsonAtomicSync, updateJsonAtomic, writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import {
    cleanSessionPreview,
    isSessionPreviewNoise,
    sessionMessageText,
} from '../../../../session-runtime/session-text.mjs';

export const SESSION_SUMMARY_INDEX_VERSION = 2;

export function summaryIndexPath() {
    const dir = getPluginData();
    mkdirSync(dir, { recursive: true });
    return join(dir, 'session-summaries.json');
}

function _messageText(content) {
    return sessionMessageText(content);
}

function _cleanPreview(text, max = 240) {
    const value = cleanSessionPreview(text, max);
    return value.length > max ? value.slice(0, max).replace(/\s+\S*$/, '').trim() : value;
}

function _isPreviewNoise(text) {
    return isSessionPreviewNoise(text);
}

const sessionMessageProjectionMemo = new WeakMap();

function _previewFromMessage(message) {
    if (message?.role !== 'user') return '';
    const raw = _messageText(message.content);
    if (_isPreviewNoise(raw)) return '';
    return _cleanPreview(raw);
}

function _sessionMessageProjection(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const cached = session && typeof session === 'object'
        ? sessionMessageProjectionMemo.get(session)
        : null;
    let start = 0;
    let count = 0;
    let preview = '';
    let previewMessage = null;
    const canAppend = cached
        && messages.length >= cached.length
        && (cached.length === 0 || messages[cached.length - 1] === cached.lastMessage);
    if (canAppend) {
        start = cached.length;
        count = cached.count;
        preview = cached.preview;
        previewMessage = cached.previewMessage;
        // The first real user message is stable in normal append-only session
        // flow, but refresh it cheaply so an in-place content scrub still
        // invalidates the cached title source without rescanning the transcript.
        if (previewMessage) {
            const refreshed = _previewFromMessage(previewMessage);
            if (refreshed) preview = refreshed;
            else {
                start = 0;
                count = 0;
                preview = '';
                previewMessage = null;
            }
        }
    }
    for (let index = start; index < messages.length; index += 1) {
        const message = messages[index];
        if (message && (message.role === 'user' || message.role === 'assistant')) count += 1;
        if (!preview) {
            const candidate = _previewFromMessage(message);
            if (candidate) {
                preview = candidate;
                previewMessage = message;
            }
        }
    }
    if (session && typeof session === 'object') {
        sessionMessageProjectionMemo.set(session, {
            length: messages.length,
            lastMessage: messages[messages.length - 1] || null,
            count,
            preview,
            previewMessage,
        });
    }
    return { count, preview };
}

function _positiveNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _desktopSessionSummary(value, cwd = null) {
    if (!value || typeof value !== 'object') return null;
    if (value.classification === 'task') {
        return { classification: 'task', projectPath: null };
    }
    if (value.classification !== 'project') return null;
    const cleanPath = (path) => {
        if (typeof path !== 'string') return null;
        const trimmed = path.trim();
        return trimmed && !trimmed.includes('\0') ? trimmed : null;
    };
    const projectPath = cleanPath(value.projectPath) || cleanPath(cwd);
    return projectPath ? { classification: 'project', projectPath } : null;
}

export function _sessionSummary(session) {
    if (!session?.id) return null;
    const messageProjection = _sessionMessageProjection(session);
    return {
        id: String(session.id),
        updatedAt: _positiveNumber(session.updatedAt, Date.now()),
        // Conversation activity is intentionally separate from lifecycle
        // bookkeeping. Resume/detach saves can advance updatedAt without a
        // user-visible turn and must not reshuffle Recent session lists.
        lastUsedAt: _positiveNumber(session.lastUsedAt, 0),
        createdAt: _positiveNumber(session.createdAt, 0),
        lastHeartbeatAt: _positiveNumber(session.lastHeartbeatAt, 0),
        closed: session.closed === true,
        status: String(session.status || (session.closed === true ? 'closed' : 'idle')),
        owner: session.owner || 'user',
        agent: session.agent || null,
        sourceType: session.sourceType || null,
        sourceName: session.sourceName || null,
        scopeKey: session.scopeKey || null,
        ownerSessionId: session.ownerSessionId || null,
        clientHostPid: _positiveNumber(session.clientHostPid, 0) || null,
        cwd: session.cwd || '',
        desktopSession: _desktopSessionSummary(session.desktopSession, session.cwd),
        provider: session.provider || null,
        model: session.model || null,
        agentTag: session.agentTag || null,
        task_id: session.task_id || session.taskId || null,
        permission: session.permission || null,
        toolPermission: session.toolPermission || null,
        messageCount: messageProjection.count,
        preview: messageProjection.preview,
        generation: typeof session.generation === 'number' ? session.generation : 0,
        implicitBashSessionId: session.implicitBashSessionId || null,
    };
}

function _normalizeSummaryRow(row) {
    if (!row?.id || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id)) return null;
    return {
        id: row.id,
        updatedAt: _positiveNumber(row.updatedAt, 0),
        lastUsedAt: _positiveNumber(row.lastUsedAt, 0),
        createdAt: _positiveNumber(row.createdAt, 0),
        lastHeartbeatAt: _positiveNumber(row.lastHeartbeatAt, 0),
        closed: row.closed === true,
        status: String(row.status || (row.closed === true ? 'closed' : 'idle')),
        owner: row.owner || 'user',
        agent: row.agent || null,
        sourceType: row.sourceType || null,
        sourceName: row.sourceName || null,
        scopeKey: row.scopeKey || null,
        ownerSessionId: row.ownerSessionId || null,
        clientHostPid: _positiveNumber(row.clientHostPid, 0) || null,
        cwd: row.cwd || '',
        desktopSession: _desktopSessionSummary(row.desktopSession, row.cwd),
        provider: row.provider || null,
        model: row.model || null,
        agentTag: row.agentTag || null,
        task_id: row.task_id || null,
        permission: row.permission || null,
        toolPermission: row.toolPermission || null,
        messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
        preview: _cleanPreview(row.preview || ''),
        generation: typeof row.generation === 'number' ? row.generation : 0,
        implicitBashSessionId: row.implicitBashSessionId || null,
    };
}

export function _normalizeSummaryIndex(raw) {
    const rows = Array.isArray(raw?.rows) ? raw.rows.map(_normalizeSummaryRow).filter(Boolean) : [];
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { version: SESSION_SUMMARY_INDEX_VERSION, updatedAt: _positiveNumber(raw?.updatedAt, 0), rows };
}

export function _writeSummaryIndex(rows) {
    const cleanRows = (rows || []).map(_normalizeSummaryRow).filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    writeJsonAtomicSync(summaryIndexPath(), {
        version: SESSION_SUMMARY_INDEX_VERSION,
        updatedAt: Date.now(),
        rows: cleanRows,
    }, { compact: true, lock: true });
    return cleanRows;
}

// ── Non-blocking upsert/remove ──────────────────────────────────────────────
// The summary index is a best-effort sidecar, but its writers used to take
// the cross-process file lock with the DEFAULT 8s timeout — and
// withFileLockSync waits with Atomics.wait, which BLOCKS the main thread.
// Every session save calls _upsertSessionSummary, so with several mixdog
// processes (TUI + agent workers + memory service) contending on a multi-MB
// index, a busy lock froze typing/rendering for seconds at a time.
// Now: callers only QUEUE the mutation (O(1), no I/O) and the flush runs on
// a deferred tick with a ZERO-WAIT try-lock — if another process holds the
// lock we never sleep on it, we re-queue and retry on an unref'd timer. The
// caller's thread never blocks on this lock at all.
const SUMMARY_LOCK_TIMEOUT_MS = 0; // try-lock: acquire-or-fail, never wait
const SUMMARY_RETRY_DELAY_MS = 1000;
const _pendingUpserts = new Map(); // id → summary row (latest wins)
const _pendingRemovals = new Set(); // ids to drop (upsert/removal are mutually exclusive per id)
let _summaryRetryTimer = null;
let _summaryFlushScheduled = false;
let _summaryFlushInflight = 0;

export function _hasUnsettledSummaryOps() {
    return _pendingUpserts.size > 0 || _pendingRemovals.size > 0
        || _summaryFlushScheduled || _summaryFlushInflight > 0;
}

function _scheduleSummaryRetry() {
    if (_summaryRetryTimer) return;
    _summaryRetryTimer = setTimeout(() => {
        _summaryRetryTimer = null;
        _flushPendingSummaryOps();
    }, SUMMARY_RETRY_DELAY_MS);
    _summaryRetryTimer.unref?.();
}

// Defer the flush off the caller's stack: the 1MB+ parse/stringify inside
// updateJsonAtomicSync (~10ms on a warm cache) has no business on the
// keystroke/session-save path.
function _scheduleSummaryFlush() {
    if (_summaryFlushScheduled) return;
    _summaryFlushScheduled = true;
    setImmediate(() => {
        _summaryFlushScheduled = false;
        _flushPendingSummaryOps();
    });
}

export function _flushPendingSummaryOps({ sync = false } = {}) {
    if (_pendingUpserts.size === 0 && _pendingRemovals.size === 0) return;
    // Snapshot + clear first: ops queued by other callers DURING the flush
    // must not be lost, and a failed flush re-queues only what it took
    // (without clobbering anything newer queued meanwhile).
    const upserts = new Map(_pendingUpserts);
    const removals = new Set(_pendingRemovals);
    _pendingUpserts.clear();
    _pendingRemovals.clear();
    const mutate = (cur) => {
            const index = _normalizeSummaryIndex(cur);
            const existingById = new Map(index.rows.map((row) => [row.id, row]));
            let changed = false;
            const rows = index.rows.filter((r) => {
                if (removals.has(r.id) || upserts.has(r.id)) { changed = true; return false; }
                return true;
            });
            for (const row of upserts.values()) {
                const cleanRow = _normalizeSummaryRow(row);
                if (!cleanRow) continue;
                const existing = existingById.get(cleanRow.id) || null;
                if (existing && JSON.stringify(existing) === JSON.stringify(cleanRow)) {
                    rows.push(existing);
                    continue;
                }
                rows.push(cleanRow);
                changed = true;
            }
            if (!changed) return undefined;
            rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return { version: SESSION_SUMMARY_INDEX_VERSION, updatedAt: Date.now(), rows };
    };
    const requeue = () => {
        // Lock busy (or transient I/O failure) — re-queue what we took unless
        // a newer op for the same id arrived during the flush, then retry
        // asynchronously.
        for (const [id, row] of upserts) {
            if (!_pendingUpserts.has(id) && !_pendingRemovals.has(id)) _pendingUpserts.set(id, row);
        }
        for (const id of removals) {
            if (!_pendingUpserts.has(id)) _pendingRemovals.add(id);
        }
        _scheduleSummaryRetry();
    };
    // Exit-drain path needs the synchronous write (the loop may not pump
    // after 'exit'). Normal scheduled flushes on the lead/TUI main process
    // use the async try-lock: the lock WAIT is off the event loop, so a
    // busy multi-MB index never freezes typing/rendering.
    if (sync) {
        try {
            updateJsonAtomicSync(summaryIndexPath(), mutate, { compact: true, lock: true, timeoutMs: SUMMARY_LOCK_TIMEOUT_MS });
        } catch { requeue(); }
        return;
    }
    _summaryFlushInflight++;
    updateJsonAtomic(summaryIndexPath(), mutate, { compact: true, lock: true, timeoutMs: SUMMARY_LOCK_TIMEOUT_MS })
        .catch(() => { requeue(); })
        .finally(() => { _summaryFlushInflight--; });
}

export function _upsertSessionSummary(session) {
    const row = _sessionSummary(session);
    _upsertSessionSummaryRow(row);
}

export function _upsertSessionSummaryRow(row) {
    if (!row) return;
    _pendingRemovals.delete(row.id);
    _pendingUpserts.set(row.id, row);
    _scheduleSummaryFlush();
}

export function _removeSessionSummary(id) {
    if (!id) return;
    _pendingUpserts.delete(id);
    _pendingRemovals.add(id);
    _scheduleSummaryFlush();
}

/**
 * Batch removal: prune MANY ids from the summary index in a single
 * read-modify-write. Bulk deleters (tombstone sweep) must use this instead
 * of per-id _removeSessionSummary — the index is O(sessions) in size, so
 * per-id rewrites make a large sweep quadratic in total I/O.
 */
export function _pruneSummaryIndexIds(ids) {
    if (!(ids instanceof Set) || ids.size === 0) return;
    for (const id of ids) {
        _pendingUpserts.delete(id);
        _pendingRemovals.add(id);
    }
    _scheduleSummaryFlush();
}
