// Recall-fasttrack compaction pipeline (digest injection).
// Reads the session transcript already persisted by the memory watcher, then
// injects a small newest-first digest + recall pointer into the
// compacted messages. The former full-dump path (dump_session_roots +
// synchronous cycle1 drain) was removed 2026-07: the drain ran memory-
// pipeline LLM chunking calls inside the compaction (11.9s of a measured
// 12.9s compact) and still left raw rows behind; background cycle1 already
// chunks ingested rows on its own schedule, and recall serves the rest.
import { createHash } from 'crypto';
import { executeInternalTool } from '../../internal-tools.mjs';
import {
    recallFastTrackCompactMessages,
    CONTEXT_SHARE_RATIO,
    RECALL_TOKEN_CAP_FLOOR_TOKENS,
} from '../compact.mjs';
import {
    compactDiagnosticError,
    compactByteLength,
    compactDebugLog,
} from './compact-debug.mjs';
import { positiveTokenInt } from './env.mjs';

// ── Digest injection ────────────────────────────────────────────────────────
// Memory provides every available summary/raw row. Only the final compaction
// budget is allowed to reduce the handoff.
function buildRecallDigestText(sessionId, digestBody) {
    // The summary record already owns the compaction envelope. Keep one small
    // scope line, then preserve the Memory handoff byte-for-byte instead of
    // parsing and rebuilding a second conversation/tool/file dump.
    return [
        `recall_session=${sessionId} order=newest_first`,
        String(digestBody || '').trim(),
    ].join('\n');
}

// Abort/cancel detection: a cancelled session (ESC / new prompt / signal abort)
// surfaces as an AbortError or a DOMException with ABORT_ERR from the internal
// tool. That is NOT a memory-pipeline failure — rethrow it unchanged so the
// caller records a cancellation, never an AGENT_CONTEXT_OVERFLOW.
function isAbortLikeError(err, signal) {
    if (signal?.aborted) return true;
    if (!err) return false;
    const name = err.name || '';
    const code = err.code || '';
    if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'ABORT') return true;
    const msg = String(err.message || err).toLowerCase();
    return /\babort(ed|ing)?\b|\bcancel(l?ed|ling)?\b/.test(msg);
}

// A stalled memory call must NEVER wedge compaction. Every recall-fasttrack
// memory call is bounded here — the default path included — so the protection
// no longer depends on which caller happened to wire a bounded search in.
export const RECALL_MEMORY_CALL_TIMEOUT_MS = Math.max(
    250,
    Number(process.env.MIXDOG_AGENT_COMPACT_RECALL_TIMEOUT_MS) || 4000,
);
// Cold-start allowance: a booting memory runtime can miss the tight first bound
// (waitForPort + first-RPC warmup ~2-10s). On a timeout we retry ONCE with a
// longer bound before honoring the bail contract, so a rebooting runtime
// succeeds instead of instantly failing. 15s keeps the clear path's worst case
// (2 retried memory calls + 120s semantic) under the TUI watchdog (180s).
export const RECALL_COLD_START_TIMEOUT_MS = 15_000;

export function recallMemoryTimeoutMs(session) {
    const configured = Number(session?.compaction?.recallMemoryTimeoutMs);
    // Clamp ALL sources (session config included) to the 250ms floor so a
    // misconfigured tiny value can't turn the bound into a busy no-wait.
    return Math.max(250, Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : RECALL_MEMORY_CALL_TIMEOUT_MS);
}

function isTimeoutError(err) {
    return typeof err?.message === 'string' && err.message.includes('timed out after');
}

export async function callMemoryBounded(args, callerCtx, timeoutMs, executeMemory = executeInternalTool) {
    const ac = new AbortController();
    const outer = callerCtx?.signal;
    const onOuterAbort = () => { try { ac.abort(); } catch {} };
    if (outer) {
        if (outer.aborted) ac.abort();
        else { try { outer.addEventListener?.('abort', onOuterAbort, { once: true }); } catch {} }
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { ac.abort(); } catch {}
            reject(new Error(`memory ${args?.action || 'call'} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try { timer.unref?.(); } catch {}
    });
    try {
        return await Promise.race([
            executeMemory('memory', args, { ...callerCtx, signal: ac.signal }),
            timeout,
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        // Drop the chained-abort listener when the call settles first, so a
        // later outer abort can't fire into a dead controller / leak.
        try { outer?.removeEventListener?.('abort', onOuterAbort); } catch {}
    }
}

export async function callMemoryColdStart(args, callerCtx, timeoutMs, executeMemory) {
    try {
        return await callMemoryBounded(args, callerCtx, timeoutMs, executeMemory);
    } catch (err) {
        if (!isTimeoutError(err) || callerCtx?.signal?.aborted) throw err;
        const coldMs = Math.max(timeoutMs, RECALL_COLD_START_TIMEOUT_MS);
        if (coldMs <= timeoutMs) throw err;
        try { process.stderr.write(`[session] recall-fasttrack ${args?.action || 'call'} cold-start retry (${timeoutMs}ms -> ${coldMs}ms)\n`); } catch {}
        return await callMemoryBounded(args, callerCtx, coldMs, executeMemory);
    }
}

export function isUsableRecallDigestText(value) {
    const text = typeof value === 'string' ? value : String(value?.text ?? value ?? '');
    const trimmed = text.trim();
    return !!trimmed && !/^\((?:no results|no current session)\)$/i.test(trimmed);
}

export const RECALL_FAST_TRACK_TAIL_TURNS = 5;

export async function runRecallFastTrackCompact({
    sessionRef,
    messages,
    compactBudgetTokens,
    compactPolicy,
    sessionId,
    signal,
    executeMemorySearch,
}) {
    if (!sessionId) throw new Error('recall-fasttrack requires a session id');
    const startedAt = Date.now();
    // Digest mode only: the full-dump pipeline's per-cycle counters were
    // removed with it in 2026-07 and had been logging fixed nulls since.
    const diagnostics = {
        memorySource: 'existing-session',
        searchMs: null,
        searchError: null,
        finalRecallBytes: null,
        finalRecallChars: null,
        totalMs: null,
    };
    const query = `session:${sessionId}:all-chunks`;
    const querySha = createHash('sha256').update(query).digest('hex').slice(0, 16);
    const callerCtx = {
        callerSessionId: sessionId || null,
        callerCwd: sessionRef?.cwd || undefined,
        routingSessionId: sessionId || null,
        clientHostPid: sessionRef?.clientHostPid,
        signal: signal || null,
    };
    let searchFailed = false;
    let searchErr = null;
    // Build the compact handoff from the session rows the always-on transcript
    // watcher already persisted. Do not retransmit the live transcript through
    // the memory RPC: that duplicates canonical history and can exceed the
    // bounded HTTP request body before compaction gets a chance to run.
    let digestBody = '';
    const t0 = Date.now();
    try {
        // The default path is bounded exactly like the caller-supplied one: an
        // unbounded memory call here would hang the pre-send compaction that
        // runs between the user's prompt and the provider request.
        const searchMemory = typeof executeMemorySearch === 'function'
            ? executeMemorySearch
            : (args, ctx) => callMemoryColdStart(
                args,
                ctx,
                recallMemoryTimeoutMs(sessionRef),
                executeInternalTool,
            );
        const browsed = await searchMemory({
            action: 'search',
            sessionId,
            limit: 30,
            includeMembers: true,
            includeRaw: true,
            compactHandoff: true,
        }, callerCtx);
        digestBody = typeof browsed === 'string' ? browsed : String(browsed?.text ?? browsed ?? '');
        if (!isUsableRecallDigestText(digestBody)) {
            throw new Error('memory has no stored history for this session');
        }
    } catch (err) {
        searchFailed = true;
        searchErr = err;
        diagnostics.searchError = compactDiagnosticError(err);
        try { process.stderr.write(`[loop] recall-digest browse failed (sess=${sessionId || 'unknown'}): ${err?.message || err}\n`); } catch {}
    }
    diagnostics.searchMs = Date.now() - t0;
    // Fail-safe: an unavailable or empty stored session cannot support a
    // truthful recall handoff. Preserve the live head and let the caller use
    // the semantic fallback instead of silently dropping history.
    if (searchFailed) {
        diagnostics.totalMs = Date.now() - startedAt;
        diagnostics.failSafeAbort = true;
        compactDebugLog('recall-digest pipeline', diagnostics);
        // Cancellation is not a memory failure: rethrow the original abort error
        // unchanged so the session is marked cancelled, not context-overflow.
        const abortErr = isAbortLikeError(searchErr, signal) ? searchErr
            : (signal?.aborted ? searchErr : null);
        if (abortErr) {
            try { process.stderr.write(`[loop] recall-fasttrack cancelled (sess=${sessionId || 'unknown'}): ${abortErr?.message || abortErr}\n`); } catch {}
            throw abortErr;
        }
        try { process.stderr.write(`[loop] recall-fasttrack fail-safe abort (sess=${sessionId || 'unknown'}): stored session unavailable — keeping full history, no recall notice injected\n`); } catch {}
        throw new Error(`recall-fasttrack aborted: stored session memory unavailable; head preserved`);
    }
    const digestText = buildRecallDigestText(sessionId, digestBody);
    diagnostics.finalRecallChars = digestText.length;
    diagnostics.finalRecallBytes = compactByteLength(digestText);
    const contextWindow = positiveTokenInt(compactPolicy?.contextWindow)
        || positiveTokenInt(compactPolicy?.boundaryTokens)
        || positiveTokenInt(sessionRef?.contextWindow)
        || positiveTokenInt(sessionRef?.compactBoundaryTokens);
    const recallTokenCap = contextWindow
        ? Math.max(RECALL_TOKEN_CAP_FLOOR_TOKENS, Math.floor(contextWindow * CONTEXT_SHARE_RATIO))
        : null;
    const result = recallFastTrackCompactMessages(messages, compactBudgetTokens, {
        reserveTokens: compactPolicy.reserveTokens,
        force: true,
        recallText: digestText,
        query,
        querySha,
        cwd: sessionRef?.cwd,
        sessionId,
        // Empty/sentinel browse output was rejected above, so the handoff always
        // contains real stored session context.
        allowEmptyRecall: false,
        tailTurns: RECALL_FAST_TRACK_TAIL_TURNS,
        keepTokens: compactPolicy.keepTokens,
        preserveRecentTokens: compactPolicy.preserveRecentTokens,
        recallTokenCap,
    });
    diagnostics.totalMs = Date.now() - startedAt;
    if (result && typeof result === 'object') {
        result.diagnostics = { ...(result.diagnostics || {}), pipeline: { ...diagnostics, digestMode: true } };
    }
    compactDebugLog('recall-digest pipeline', diagnostics);
    return result;
}
