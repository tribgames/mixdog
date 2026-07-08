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
import { TOOL_OUTPUT_MAX_BYTES } from '../../tools/builtin/tool-output-limit.mjs';

// ── Digest injection ────────────────────────────────────────────────────────
// Inject a small newest-first digest plus an instruction telling the model to
// pull details lazily via recall(sessionId/query/period). The memory DB holds
// the full session (ingest_session below), and raw rows are embedded
// synchronously at ingest, so recall serves everything the old full-dump
// injection used to carry.
// Default digest cap = the SHARED tool-output limit (TOOL_OUTPUT_MAX_BYTES,
// 50KB default, env MIXDOG_TOOL_OUTPUT_MAX_BYTES) — the digest injection is
// budgeted like any other tool result, not a special context share.
// compaction.recallDigestMaxKb still overrides per-session.
export const DIGEST_DEFAULT_MAX_KB = Math.max(1, Math.floor(TOOL_OUTPUT_MAX_BYTES / 1024));

// Byte-capped line-boundary truncation. Digest source is newest-first, so
// keeping the HEAD keeps the newest turns.
// Exported for manager/compaction-runner.mjs (manual//clear digest path) so
// both digest producers share one cap implementation.
export function truncateToKb(text, maxKb) {
    const maxBytes = Math.max(1, maxKb) * 1024;
    const s = String(text || '');
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    const lines = s.split('\n');
    const out = [];
    let used = 0;
    for (const line of lines) {
        const cost = Buffer.byteLength(line, 'utf8') + 1;
        if (used + cost > maxBytes) break;
        out.push(line);
        used += cost;
    }
    return out.join('\n') + '\n[digest truncated at ' + maxKb + 'KB — pull the rest via recall]';
}

function buildRecallDigestText(sessionId, digestBody, maxKb) {
    // No recall-usage instruction block here: the recall tool description
    // already carries the usage-pattern cheatsheet (tool-defs.mjs), so
    // repeating it per-compaction would be redundant injected tokens. The
    // one-line header marks the compaction boundary and names the session id
    // the model needs for a scoped recall.
    return [
        `[context compacted — session ${sessionId}]`,
        `Full history is in memory — use the recall tool for details beyond this digest.`,
        `Recent digest (newest first):`,
        truncateToKb(digestBody, maxKb),
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

export async function runRecallFastTrackCompact({ sessionRef, messages, compactBudgetTokens, compactPolicy, sessionId, signal }) {
    if (!sessionId) throw new Error('recall-fasttrack requires a session id');
    const startedAt = Date.now();
    const diagnostics = {
        hydrateLimit: null,
        ingestMs: null,
        ingestSkipped: false,
        ingestError: null,
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
    const hydrateLimit = positiveTokenInt(sessionRef?.compaction?.recallIngestLimit)
        || Math.max(500, Math.min(5000, messages.length || 0));
    diagnostics.hydrateLimit = hydrateLimit;
    let t0 = Date.now();
    let ingestFailed = false;
    let searchFailed = false;
    let ingestErr = null;
    let searchErr = null;
    try {
        await executeInternalTool('memory', {
            action: 'ingest_session',
            sessionId,
            messages,
            cwd: sessionRef?.cwd,
            limit: hydrateLimit,
            // Pre-send fast-track compaction: these rows are about to be
            // summarized away, so skip the bounded synchronous embedding-flush
            // wait — kick the flush fire-and-forget. Mirrors the manual/auto-clear
            // runner (manager/compaction-runner.mjs) embedWait:false policy.
            embedWait: false,
        }, callerCtx);
    } catch (err) {
        ingestFailed = true;
        ingestErr = err;
        diagnostics.ingestSkipped = true;
        diagnostics.ingestError = compactDiagnosticError(err);
        try { process.stderr.write(`[loop] recall-fasttrack ingest skipped (sess=${sessionId || 'unknown'}): ${err?.message || err}\n`); } catch {}
    } finally {
        diagnostics.ingestMs = Date.now() - t0;
    }
    // ── Digest injection (the only mode) ──────────────────────────────────
    // The old full-dump path (dump_session_roots + synchronous cycle1 drain)
    // is gone: the drain ran memory-pipeline LLM chunking calls INSIDE the
    // compaction (measured 11.9s of a 12.9s compact) and still often left
    // rawRemaining>0. Instead inject a small newest-first digest plus a
    // recall pointer; ingest_session above already put the full transcript
    // in the memory DB, and background cycle1 chunks it on its own schedule.
    const digestMaxKb = positiveTokenInt(sessionRef?.compaction?.recallDigestMaxKb) || DIGEST_DEFAULT_MAX_KB;
    let digestBody = '';
    t0 = Date.now();
    try {
        const browsed = await executeInternalTool('memory', {
            action: 'search',
            sessionId,
            limit: positiveTokenInt(sessionRef?.compaction?.recallDigestLimit) || 30,
            includeMembers: true,
            includeRaw: true,
        }, callerCtx);
        digestBody = typeof browsed === 'string' ? browsed : String(browsed?.text ?? browsed ?? '');
    } catch (err) {
        searchFailed = true;
        searchErr = err;
        diagnostics.cycle1Error = compactDiagnosticError(err);
        try { process.stderr.write(`[loop] recall-digest browse failed (sess=${sessionId || 'unknown'}): ${err?.message || err}\n`); } catch {}
    }
    diagnostics.initialDumpMs = Date.now() - t0;
    diagnostics.cycle1Skipped = true;
    diagnostics.cycle1SkipReason = 'digest mode';
    diagnostics.cycle1Passes = 0;
    // Fail-safe: memory ingest or search failed, so the digest cannot honestly
    // represent "full history is in memory". Do NOT drop head messages behind a
    // false recall notice — abort the fast-track so no context is silently lost
    // for this cycle. The failure is already on stderr above; surface it here
    // too and record it in the diagnostics before throwing.
    if (ingestFailed || searchFailed) {
        diagnostics.totalMs = Date.now() - startedAt;
        diagnostics.failSafeAbort = true;
        compactDebugLog('recall-digest pipeline', diagnostics);
        // Cancellation is not a memory failure: rethrow the original abort error
        // unchanged so the session is marked cancelled, not context-overflow.
        const abortErr = isAbortLikeError(ingestErr, signal) ? ingestErr
            : isAbortLikeError(searchErr, signal) ? searchErr
            : (signal?.aborted ? (ingestErr || searchErr) : null);
        if (abortErr) {
            try { process.stderr.write(`[loop] recall-fasttrack cancelled (sess=${sessionId || 'unknown'}): ${abortErr?.message || abortErr}\n`); } catch {}
            throw abortErr;
        }
        const reason = ingestFailed
            ? (searchFailed ? 'ingest+search failed' : 'ingest failed')
            : 'search failed';
        try { process.stderr.write(`[loop] recall-fasttrack fail-safe abort (sess=${sessionId || 'unknown'}): ${reason} — keeping full history, no recall notice injected\n`); } catch {}
        throw new Error(`recall-fasttrack aborted: memory ${reason}; head preserved`);
    }
    const digestText = buildRecallDigestText(sessionId, digestBody, digestMaxKb);
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
        // Ingest + search both succeeded above, so the memory DB genuinely holds
        // this transcript and the recall notice is truthful even when the digest
        // body is small. A failure would have aborted before reaching here.
        allowEmptyRecall: true,
        tailTurns: compactPolicy.tailTurns,
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
