// manager/session-crud.mjs
// Session read + mutate CRUD extracted verbatim from manager.mjs: lookup
// (getSession/listSessions/findSessionByScopeKey), message clear (with
// clear-fork), manual compaction, status update, and metric flush.
import { loadSession, saveSessionAsync, setLiveSession, listStoredSessionSummaries } from '../store.mjs';
import { estimateMessagesTokens, estimateTranscriptContextUsage } from '../context-utils.mjs';
import { normalizeCompactType, DEFAULT_COMPACT_TYPE, SUMMARY_PREFIX } from '../compact.mjs';
import { runSessionCompaction } from './compaction-runner.mjs';
import { hasUserConversationMessage } from './prompt-utils.mjs';
import { getProvider } from '../../providers/registry.mjs';
import { isSessionCompactionBlocked, getSessionAbortSignal, _runtimeEntries } from './runtime-liveness.mjs';
import { mintSessionId } from './session-id.mjs';

/** Force-flush session metrics to disk. Used by watchdog terminal-reap (fix B). */
export async function flushSessionMetrics(sessionId) {
    if (!sessionId) return;
    const session = loadSession(sessionId);
    if (!session) return;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
}

// Session lookup by scopeKey — used by CLI agent to resume a pinned
// scope session when the caller passes --scope (agent/<name>).
export function findSessionByScopeKey(scopeKey) {
    if (!scopeKey) return null;
    const summaries = listStoredSessionSummaries();
    // Exclude tombstoned sessions (`closed === true`) so callers never receive
    // a session whose controller was aborted by closeSession(). The `closed`
    // bit is the authoritative tombstone flag; `status === 'error'` is not,
    // since transient-error sessions remain resumable.
    const summary = summaries.find(s => s.scopeKey === scopeKey && s.closed !== true) || null;
    return summary?.id ? loadSession(summary.id) : null;
}

// --- CRUD ---
export function getSession(id) {
    return loadSession(id);
}
export function listSessions(opts = {}) {
    const includeClosed = opts.includeClosed === true;
    const sessions = listStoredSessionSummaries();
    const hiddenIds = new Set([..._runtimeEntries()].filter(([, e]) => e.listHidden).map(([id]) => id));
    // Tombstoned sessions (closed===true) are excluded unless the caller opts in
    // (e.g. agent list includeClosed:true).
    return sessions.filter(s => !hiddenIds.has(s.id) && (includeClosed || s.closed !== true));
}
// --- Clear messages (keep system prompt + provider/model/cwd) ---
export async function clearSessionMessages(sessionId, options = {}) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    const clearOptions = options && typeof options === 'object' ? options : {};
    const requestedCompactType = clearOptions.compactType ?? clearOptions.compact_type ?? clearOptions.type;
    const compactBeforeClear = requestedCompactType != null && requestedCompactType !== false && String(requestedCompactType).trim() !== '';
    const keep = [];
    let messages = Array.isArray(session.messages) ? session.messages : [];
    const beforeMessageTokens = estimateMessagesTokens(messages);
    let clearCompactType = null;
    let clearCompactError = null;
    if (compactBeforeClear && messages.length >= 3) {
        clearCompactType = normalizeCompactType(requestedCompactType, DEFAULT_COMPACT_TYPE);
        session.compaction = {
            ...(session.compaction || {}),
            type: clearCompactType,
            compactType: clearCompactType,
        };
        try {
            const compactResult = await runSessionCompaction(session, { mode: 'manual', force: true, sessionId });
            if (compactResult?.error) {
                clearCompactError = new Error(compactResult.error);
            }
        } catch (err) {
            clearCompactError = err;
            try { process.stderr.write(`[session] auto-clear pre-compact failed (sess=${sessionId}): ${err?.message || err}\n`); } catch { /* best-effort */ }
        }
        messages = Array.isArray(session.messages) ? session.messages : [];
    }
    if (compactBeforeClear && clearOptions.requireCompactSuccess === true) {
        const hasRetainedSummary = messages.some((m) => (
            m?.role === 'user'
            && typeof m.content === 'string'
            && m.content.startsWith(SUMMARY_PREFIX)
        ));
        if (!hasRetainedSummary && !clearCompactError) {
            clearCompactError = new Error('compact produced no retained summary');
        }
    }
    if (clearCompactError && clearOptions.requireCompactSuccess === true) {
        const now = Date.now();
        session.compaction = {
            ...(session.compaction || {}),
            lastStage: 'auto_clear_failed',
            lastCheckedAt: now,
            lastChanged: false,
            lastClearAt: session.compaction?.lastClearAt || null,
            lastClearCompactType: clearCompactType || session.compaction?.compactType || null,
            lastClearCompactError: clearCompactError?.message || String(clearCompactError),
        };
        session.updatedAt = now;
        await saveSessionAsync(session, { expectedGeneration: session.generation });
        throw new Error(`auto-clear compact failed; conversation kept: ${session.compaction.lastClearCompactError}`);
    }
    const preserveCompactSummary = compactBeforeClear && clearOptions.keepCompactSummary !== false;
    for (let i = 0; i < messages.length; i += 1) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'system') {
            // BP1/BP2/BP3 all ride `role:'system'` blocks now (BP3 sessionMarker
            // moved off the `<system-reminder>` user wrapper), so the stable
            // memory/meta layer is preserved here unconditionally — no sentinel
            // scan / dummy-assistant pairing needed anymore.
            keep.push(m);
            continue;
        }
        if (preserveCompactSummary
            && m.role === 'user'
            && typeof m.content === 'string'
            && m.content.startsWith(SUMMARY_PREFIX)) {
            keep.push(m);
        }
    }
    const afterMessageTokens = estimateMessagesTokens(keep);
    const beforeTokens = estimateTranscriptContextUsage(messages, session.tools || []);
    const afterTokens = estimateTranscriptContextUsage(keep, session.tools || []);
    const now = Date.now();
    // --- Fork the outgoing transcript to a separate resumable session BEFORE
    // the wipe below. Runs for every clear path (plain /clear, auto-clear,
    // compact_clear) using the ORIGINAL `messages` (post-compact-gating, i.e.
    // whatever survived the requireCompactSuccess throw above), so the
    // conversation about to be discarded stays reachable via /resume under a
    // fresh id. Skipped for scratch sessions with no real user turn — nothing
    // worth resuming. Best-effort: any failure here must never block the
    // clear itself (mirrors the pre-compact failure handling above).
    if (hasUserConversationMessage(messages)) {
        try {
            const forkId = mintSessionId();
            const fork = {
                ...session,
                id: forkId,
                messages: messages.map((m) => (m && typeof m === 'object' ? { ...m } : m)),
                closed: false,
                status: 'idle',
                generation: 0,
                createdAt: now,
                updatedAt: now,
                lastUsedAt: now,
                lastHeartbeatAt: null,
                mcpPid: process.pid,
                // Strip runtime/liveness/routing state — the fork is a cold
                // snapshot, not a live process-owned session.
                clientHostPid: null,
                providerState: undefined,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCachedReadTokens: 0,
                totalCacheWriteTokens: 0,
                lastInputTokens: 0,
                lastOutputTokens: 0,
                lastCachedReadTokens: 0,
                lastCacheWriteTokens: 0,
                lastContextTokens: 0,
                lastContextTokensUpdatedAt: now,
                lastContextTokensStaleAfterCompact: false,
                // Shell state must not alias the live session: resuming the
                // fork would otherwise reuse/close the original session's
                // persistent bash shells.
                implicitBashSessionId: null,
                allBashSessionIds: undefined,
            };
            delete fork.liveTurnMessages;
            setLiveSession(fork);
            void saveSessionAsync(fork).catch((err) => {
                try { process.stderr.write(`[session] clear-fork save failed (sess=${forkId}): ${err?.message || err}\n`); } catch { /* best-effort */ }
            });
        } catch (err) {
            try { process.stderr.write(`[session] clear-fork failed (sess=${sessionId}): ${err?.message || err}\n`); } catch { /* best-effort */ }
        }
    }
    session.messages = keep;
    session.sessionStartMetaInjected = false;
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.totalCachedReadTokens = 0;
    session.totalCacheWriteTokens = 0;
    session.lastInputTokens = 0;
    session.lastOutputTokens = 0;
    session.lastCachedReadTokens = 0;
    session.lastCacheWriteTokens = 0;
    session.lastContextTokens = 0;
    session.lastContextTokensUpdatedAt = now;
    session.lastContextTokensStaleAfterCompact = false;
    session.providerState = undefined;
    session.compaction = {
        ...(session.compaction || {}),
        lastStage: 'auto_clear',
        lastBeforeTokens: beforeTokens,
        lastAfterTokens: afterTokens,
        lastBeforeMessageTokens: beforeMessageTokens,
        lastAfterMessageTokens: afterMessageTokens,
        lastPressureTokens: beforeTokens,
        lastCheckedAt: now,
        lastChanged: beforeTokens !== afterTokens,
        lastClearAt: now,
        lastClearBeforeTokens: beforeTokens,
        lastClearAfterTokens: afterTokens,
        lastClearBeforeMessageTokens: beforeMessageTokens,
        lastClearAfterMessageTokens: afterMessageTokens,
        lastClearCompactType: clearCompactType || session.compaction?.compactType || null,
        lastClearCompactError: clearCompactError?.message || null,
    };
    session.updatedAt = now;
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return session;
}
export async function compactSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session) return null;
    if (session.closed === true) return null;
    if (isSessionCompactionBlocked(sessionId)) {
        return { changed: false, reason: 'compact skipped: turn in progress' };
    }
    const result = await runSessionCompaction(session, {
        mode: 'manual',
        force: true,
        // /compact is a direct reduction of the active session transcript.
        // Do not re-ingest/search Memory (recall-fasttrack) before summarizing.
        compactType: DEFAULT_COMPACT_TYPE,
        // Older source history uses the same pure-conversation filter as
        // Memory ingest_session; protected system context and recent turns are
        // still preserved separately by semantic compaction.
        filterOldHistoryForIngest: true,
        provider: getProvider(session.provider),
        model: session.model,
        sessionId,
        signal: getSessionAbortSignal(sessionId),
    });
    if (!result) return null;
    const now = Date.now();
    if (!result.error) {
        session.lastInputTokens = 0;
        session.lastOutputTokens = 0;
        session.lastCachedReadTokens = 0;
        session.lastCacheWriteTokens = 0;
        session.lastContextTokens = 0;
        session.lastContextTokensUpdatedAt = now;
        session.lastContextTokensStaleAfterCompact = false;
    }
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return result;
}
export async function updateSessionStatus(id, status) {
    const session = loadSession(id);
    if (!session) return false;
    // Respect tombstones — don't resurrect a closed session just to update a
    // status label (agent handler emits running→idle/error around askSession).
    if (session.closed === true) return false;
    session.status = status;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return true;
}
