// Recall-fasttrack compaction pipeline (digest injection).
// Hydrates the session transcript into the memory pipeline (ingest_session),
// then injects a small newest-first digest + recall pointer into the
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
    // No recall-usage instruction block here: the recall tool description
    // already carries the usage-pattern cheatsheet (tool-defs.mjs), so
    // repeating it per-compaction would be redundant injected tokens. The
    // one-line header marks the compaction boundary and names the session id
    // the model needs for a scoped recall.
    return [
        `[context compacted — session ${sessionId}]`,
        `Recent digest (newest first):`,
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
    const diagnostics = {
        memorySource: 'existing-session',
        searchMs: null,
        searchError: null,
        initialDumpMs: null,
        initialDumpBytes: null,
        initialDumpChars: null,
        initialRawPending: null,
        cycle1Ms: null,
        cycle1Skipped: false,
        cycle1SkipReason: null,
        cycle1Passes: null,
        cycle1RawRemaining: null,
        cycle1TextBytes: null,
        cycle1Error: null,
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
    let t0 = Date.now();
    let searchFailed = false;
    let searchErr = null;
    // Build the compact handoff from the session rows the always-on transcript
    // watcher already persisted. Do not retransmit the live transcript through
    // the memory RPC: that duplicates canonical history and can exceed the
    // bounded HTTP request body before compaction gets a chance to run.
    let digestBody = '';
    t0 = Date.now();
    try {
        const searchMemory = typeof executeMemorySearch === 'function'
            ? executeMemorySearch
            : (args, ctx) => executeInternalTool('memory', args, ctx);
        const browsed = await searchMemory({
            action: 'search',
            sessionId,
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
    diagnostics.initialDumpMs = diagnostics.searchMs;
    diagnostics.cycle1Skipped = true;
    diagnostics.cycle1SkipReason = 'digest mode';
    diagnostics.cycle1Passes = 0;
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
