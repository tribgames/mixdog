// Single fresh-context Compact pipeline.
// Synchronizes the full session transcript, then injects one complete Memory
// handoff ahead of the exact latest user instruction. The former full-dump path (dump_session_roots +
// synchronous cycle1 drain) was removed 2026-07: the drain ran memory-
// pipeline LLM chunking calls inside the compaction (11.9s of a measured
// 12.9s compact) and still left raw rows behind; background cycle1 already
// chunks ingested rows on its own schedule, and recall serves the rest.
import { executeInternalTool } from '../../internal-tools.mjs';
import { projectSessionMessagesForIngest } from '../../../../memory/lib/session-ingest.mjs';
import {
    freshContextCompactMessages,
    generateFreshHandoffSummary,
    CONTEXT_SHARE_RATIO,
    HANDOFF_TOKEN_CAP_FLOOR_TOKENS,
} from '../compact.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import {
    compactDiagnosticError,
    compactByteLength,
    compactDebugLog,
} from './compact-debug.mjs';
import { positiveTokenInt } from './env.mjs';
import { estimateMessagesTokens } from '../context-utils.mjs';

// ── Digest injection ────────────────────────────────────────────────────────
// Memory provides every available summary/raw row. Only the final compaction
// budget is allowed to reduce the handoff.
function buildMemoryHandoffText(sessionId, digestBody) {
    // The summary record already owns the compaction envelope. Keep one small
    // scope line, then preserve the Memory handoff byte-for-byte instead of
    // parsing and rebuilding a second conversation/tool/file dump.
    return [
        `memory_session=${sessionId} order=oldest_first`,
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

// A stalled Memory call must NEVER wedge compaction. Every call is bounded
// here — the default path included — so the protection
// no longer depends on which caller happened to wire a bounded search in.
export const MEMORY_HANDOFF_CALL_TIMEOUT_MS = Math.max(
    250,
    Number(process.env.MIXDOG_COMPACT_MEMORY_TIMEOUT_MS) || 4000,
);
// Cold-start allowance: a booting memory runtime can miss the tight first bound
// (waitForPort + first-RPC warmup ~2-10s). On a timeout we retry ONCE with a
// longer bound before honoring the bail contract, so a rebooting runtime
// succeeds instead of instantly failing. 15s keeps the clear path's worst case
// (2 retried Memory calls + 120s handoff generation) under the TUI watchdog.
export const MEMORY_COLD_START_TIMEOUT_MS = 15_000;

export function memoryHandoffTimeoutMs(session) {
    const configured = Number(session?.compaction?.memoryTimeoutMs);
    // Clamp ALL sources (session config included) to the 250ms floor so a
    // misconfigured tiny value can't turn the bound into a busy no-wait.
    return Math.max(250, Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : MEMORY_HANDOFF_CALL_TIMEOUT_MS);
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
        const coldMs = Math.max(timeoutMs, MEMORY_COLD_START_TIMEOUT_MS);
        if (coldMs <= timeoutMs) throw err;
        try { process.stderr.write(`[session] fresh-context ${args?.action || 'call'} cold-start retry (${timeoutMs}ms -> ${coldMs}ms)\n`); } catch {}
        return await callMemoryBounded(args, callerCtx, coldMs, executeMemory);
    }
}

export function isUsableMemoryHandoffText(value) {
    const text = typeof value === 'string' ? value : String(value?.text ?? value ?? '');
    const trimmed = text.trim();
    return !!trimmed && !/^\((?:no results|no current session)\)$/i.test(trimmed);
}

function addSummaryUsage(total, usage) {
    if (!usage) return total;
    const next = total || {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
    };
    next.inputTokens += Number(usage.inputTokens) || 0;
    next.outputTokens += Number(usage.outputTokens) || 0;
    next.cachedTokens += Number(usage.cachedTokens) || 0;
    next.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0;
    return next;
}

function splitHandoffTextMessages(text, maxChars = 1_600) {
    const source = String(text || '');
    const messages = [];
    for (let offset = 0; offset < source.length; offset += maxChars) {
        messages.push({ role: 'user', content: source.slice(offset, offset + maxChars) });
    }
    return messages;
}

async function compressOversizedHandoff({
    provider,
    model,
    handoffText,
    compactBudgetTokens,
    compactPolicy,
    sessionRef,
    sessionId,
    signal,
    sendOpts,
}) {
    if (!provider || typeof provider.send !== 'function') {
        throw new Error('fresh-context oversized handoff requires a summary provider');
    }
    const groupBudget = Math.max(8_000, Math.floor(compactBudgetTokens * 0.35));
    let level = splitHandoffTextMessages(handoffText);
    let totalUsage = null;
    let round = 0;
    while (level.length > 1 || round === 0) {
        const groups = [];
        let current = [];
        for (const message of level) {
            const candidate = [...current, message];
            if (current.length > 0 && estimateMessagesTokens(candidate) > groupBudget) {
                groups.push(current);
                current = [message];
            } else {
                current = candidate;
            }
        }
        if (current.length > 0) groups.push(current);
        const next = [];
        for (let index = 0; index < groups.length; index += 1) {
            const generated = await generateFreshHandoffSummary(
                provider,
                groups[index],
                model || sessionRef?.model,
                compactBudgetTokens,
                {
                    reserveTokens: compactPolicy?.reserveTokens,
                    providerName: sessionRef?.provider || provider?.name || null,
                    sessionId: `${sessionId || 'unknown'}:handoff-${round}-${index}`,
                    cwd: sessionRef?.cwd,
                    signal,
                    sendOpts,
                    timeoutMs: compactPolicy?.handoffTimeoutMs,
                    force: true,
                    fullHandoff: true,
                },
            );
            totalUsage = addSummaryUsage(totalUsage, generated?.usage);
            const summary = String(generated?.summary || '').trim();
            if (!summary) throw new Error('fresh-context handoff compression returned an empty summary');
            next.push({ role: 'user', content: summary });
        }
        if (next.length === 1) {
            return { summary: String(next[0].content), usage: totalUsage, rounds: round + 1 };
        }
        if (next.length >= level.length) {
            throw new Error('fresh-context handoff compression made no progress');
        }
        level = next;
        round += 1;
    }
    throw new Error('fresh-context handoff compression produced no summary');
}

async function runMemoryFreshContextCompact({
    sessionRef,
    messages,
    compactBudgetTokens,
    compactPolicy,
    sessionId,
    signal,
    executeMemorySearch,
    provider,
    model,
    sendOpts,
    goalReminderText,
    activeTurn,
}) {
    if (!sessionId) throw new Error('fresh-context requires a session id');
    const startedAt = Date.now();
    // Digest mode only: the full-dump pipeline's per-cycle counters were
    // removed with it in 2026-07 and had been logging fixed nulls since.
    const diagnostics = {
        memorySource: 'existing-session',
        ingestMs: null,
        ingestError: null,
        ingestedMessages: 0,
        searchMs: null,
        searchError: null,
        finalHandoffBytes: null,
        finalHandoffChars: null,
        totalMs: null,
    };
    const query = `session:${sessionId}:all-chunks`;
    const callerCtx = {
        callerSessionId: sessionId || null,
        callerCwd: sessionRef?.cwd || undefined,
        routingSessionId: sessionId || null,
        clientHostPid: sessionRef?.clientHostPid,
        signal: signal || null,
    };
    const runMemoryAction = typeof executeMemorySearch === 'function'
        ? executeMemorySearch
        : (args, ctx) => callMemoryColdStart(
            args,
            ctx,
            memoryHandoffTimeoutMs(sessionRef),
            executeInternalTool,
        );
    let searchFailed = false;
    let searchErr = null;
    const projectedMessages = projectSessionMessagesForIngest(messages);
    diagnostics.ingestedMessages = projectedMessages.length;
    const ingestStartedAt = Date.now();
    try {
        if (projectedMessages.length > 0) {
            const ingested = await runMemoryAction({
                action: 'ingest_session',
                sessionId,
                cwd: sessionRef?.cwd,
                messages: projectedMessages,
                fullTranscript: true,
                limit: projectedMessages.length,
                embedWait: false,
            }, callerCtx);
            const ingestText = typeof ingested === 'string'
                ? ingested
                : String(ingested?.text ?? ingested ?? '');
            if (/^Error:/i.test(ingestText.trim())) {
                throw new Error(ingestText.trim());
            }
        }
    } catch (err) {
        diagnostics.ingestError = compactDiagnosticError(err);
        diagnostics.ingestMs = Date.now() - ingestStartedAt;
        diagnostics.totalMs = Date.now() - startedAt;
        diagnostics.failSafeAbort = true;
        compactDebugLog('fresh-context Memory pipeline', diagnostics);
        if (isAbortLikeError(err, signal)) throw err;
        throw new Error(`fresh-context aborted: current session transcript ingest failed; head preserved (${err?.message || err})`);
    }
    diagnostics.ingestMs = Date.now() - ingestStartedAt;
    // Build the compact handoff from the session rows the always-on transcript
    // watcher persisted plus the synchronous ingest barrier above. The barrier
    // closes the writer/watch debounce window before any live head is replaced.
    let digestBody = '';
    const t0 = Date.now();
    try {
        const browsed = await runMemoryAction({
            action: 'search',
            sessionId,
            includeMembers: true,
            includeRaw: true,
            compactHandoff: true,
            preserveLatestUserTurns: 0,
        }, callerCtx);
        digestBody = typeof browsed === 'string' ? browsed : String(browsed?.text ?? browsed ?? '');
        if (!isUsableMemoryHandoffText(digestBody)) {
            throw new Error('memory has no stored history for this session');
        }
    } catch (err) {
        searchFailed = true;
        searchErr = err;
        diagnostics.searchError = compactDiagnosticError(err);
        try { process.stderr.write(`[loop] fresh-context Memory browse failed (sess=${sessionId || 'unknown'}): ${err?.message || err}\n`); } catch {}
    }
    diagnostics.searchMs = Date.now() - t0;
    // Fail-safe: an unavailable or empty stored session cannot support a
    // truthful Memory handoff. Preserve the live head instead of silently
    // changing the source contract.
    if (searchFailed) {
        diagnostics.totalMs = Date.now() - startedAt;
        diagnostics.failSafeAbort = true;
        compactDebugLog('fresh-context Memory pipeline', diagnostics);
        // Cancellation is not a memory failure: rethrow the original abort error
        // unchanged so the session is marked cancelled, not context-overflow.
        const abortErr = isAbortLikeError(searchErr, signal) ? searchErr
            : (signal?.aborted ? searchErr : null);
        if (abortErr) {
            try { process.stderr.write(`[loop] fresh-context cancelled (sess=${sessionId || 'unknown'}): ${abortErr?.message || abortErr}\n`); } catch {}
            throw abortErr;
        }
        try { process.stderr.write(`[loop] fresh-context fail-safe abort (sess=${sessionId || 'unknown'}): stored session unavailable — keeping full history\n`); } catch {}
        throw new Error('fresh-context aborted: stored session memory unavailable; head preserved');
    }
    const digestText = buildMemoryHandoffText(sessionId, digestBody);
    diagnostics.finalHandoffChars = digestText.length;
    diagnostics.finalHandoffBytes = compactByteLength(digestText);
    const contextWindow = positiveTokenInt(compactPolicy?.contextWindow)
        || positiveTokenInt(compactPolicy?.boundaryTokens)
        || positiveTokenInt(sessionRef?.contextWindow)
        || positiveTokenInt(sessionRef?.compactBoundaryTokens);
    const handoffTokenCap = contextWindow
        ? Math.max(HANDOFF_TOKEN_CAP_FLOOR_TOKENS, Math.floor(contextWindow * CONTEXT_SHARE_RATIO))
        : null;
    const buildResult = (handoffText) => freshContextCompactMessages(messages, compactBudgetTokens, {
        reserveTokens: compactPolicy.reserveTokens,
        force: true,
        handoffText,
        query,
        cwd: sessionRef?.cwd,
        sessionId,
        allowEmptyHandoff: false,
        keepTokens: compactPolicy.keepTokens,
        preserveRecentTokens: compactPolicy.preserveRecentTokens,
        handoffTokenCap,
        latestUserPrefix: goalReminderText,
        activeTurn,
    });
    let result;
    try {
        result = buildResult(digestText);
        result.handoffSource = 'memory';
    } catch (err) {
        if (!/complete handoff exceeds|summary cannot fit/i.test(String(err?.message || err))) throw err;
        const compressed = await compressOversizedHandoff({
            provider,
            model,
            handoffText: digestText,
            compactBudgetTokens,
            compactPolicy,
            sessionRef,
            sessionId,
            signal,
            sendOpts,
        });
        result = buildResult(compressed.summary);
        result.usage = compressed.usage;
        result.handoffSource = 'memory-compressed';
        diagnostics.compressionRounds = compressed.rounds;
    }
    diagnostics.totalMs = Date.now() - startedAt;
    if (result && typeof result === 'object') {
        result.diagnostics = { ...(result.diagnostics || {}), pipeline: { ...diagnostics, digestMode: true } };
    }
    compactDebugLog('fresh-context Memory pipeline', diagnostics);
    return result;
}

export async function runFreshContextCompact(args = {}) {
    const {
        sessionRef,
        messages,
        compactBudgetTokens,
        compactPolicy,
        sessionId,
        signal,
        provider,
        model,
        sendOpts,
        goalReminderText,
        activeTurn,
    } = args;
    if (!isAgentOwner(sessionRef)) {
        return runMemoryFreshContextCompact(args);
    }
    if (!provider || typeof provider.send !== 'function') {
        throw new Error(`fresh-context summary provider unavailable: ${sessionRef?.provider || 'unknown'}`);
    }
    const startedAt = Date.now();
    const generated = await generateFreshHandoffSummary(
        provider,
        messages,
        model || sessionRef?.model,
        compactBudgetTokens,
        {
            reserveTokens: compactPolicy?.reserveTokens,
            providerName: sessionRef?.provider || provider?.name || null,
            sessionId,
            cwd: sessionRef?.cwd,
            signal,
            sendOpts,
            promptCacheKey: sendOpts?.promptCacheKey || sessionRef?.promptCacheKey || null,
            providerCacheKey: sendOpts?.providerCacheKey || sessionRef?.promptCacheKey || null,
            timeoutMs: compactPolicy?.handoffTimeoutMs,
            force: true,
            fullHandoff: true,
            filterOldHistoryForIngest: true,
        },
    );
    const handoffText = [
        `session_local=${sessionId || 'unknown'} order=oldest_first`,
        String(generated?.summary || '').trim(),
    ].filter(Boolean).join('\n');
    if (!handoffText.trim()) {
        throw new Error('fresh-context generated an empty session-local handoff');
    }
    const contextWindow = positiveTokenInt(compactPolicy?.contextWindow)
        || positiveTokenInt(compactPolicy?.boundaryTokens)
        || positiveTokenInt(sessionRef?.contextWindow)
        || positiveTokenInt(sessionRef?.compactBoundaryTokens);
    const handoffTokenCap = contextWindow
        ? Math.max(HANDOFF_TOKEN_CAP_FLOOR_TOKENS, Math.floor(contextWindow * CONTEXT_SHARE_RATIO))
        : null;
    const result = freshContextCompactMessages(messages, compactBudgetTokens, {
        reserveTokens: compactPolicy?.reserveTokens,
        force: true,
        handoffText,
        query: `session-local:${sessionId || 'unknown'}`,
        cwd: sessionRef?.cwd,
        sessionId,
        allowEmptyHandoff: false,
        keepTokens: compactPolicy?.keepTokens,
        preserveRecentTokens: compactPolicy?.preserveRecentTokens,
        handoffTokenCap,
        latestUserPrefix: goalReminderText,
        activeTurn,
    });
    result.usage = generated?.usage || null;
    result.handoffSource = 'session-local';
    result.diagnostics = {
        ...(result.diagnostics || {}),
        pipeline: {
            handoffSource: 'session-local',
            generated: generated?.diagnostics || null,
            totalMs: Date.now() - startedAt,
        },
    };
    return result;
}
