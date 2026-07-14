// Session compaction runner — recall-fasttrack / semantic / prune-fallback.
// Extracted verbatim from manager.mjs (behavior-preserving). Self-contained:
// operates on a live `session` object + opts, using pure compact/context
// helpers. No runtime-liveness (_runtimeState) coupling — manager.mjs still
// owns scheduling / stage gating and simply calls runSessionCompaction().
import { createHash } from 'crypto';
import { getProvider } from '../../providers/registry.mjs';
import {
    recallFastTrackCompactMessages,
    semanticCompactMessages,
    pruneToolOutputsUnanchored,
    effectiveBudget as compactEffectiveBudget,
    compactTypeIsRecallFastTrack,
    compactTypeIsSemantic,
    CONTEXT_SHARE_RATIO,
    RECALL_TOKEN_CAP_FLOOR_TOKENS,
} from '../compact.mjs';
import { estimateMessagesTokens, estimateRequestReserveTokens, estimateTranscriptContextUsage, resolveCompactBufferRatio } from '../context-utils.mjs';
import { executeInternalTool } from '../../internal-tools.mjs';
import { truncateToKb, DIGEST_DEFAULT_MAX_KB } from '../loop/recall-fasttrack.mjs';
import {
    positiveContextWindow,
    semanticCompactionEnabledForSession,
    compactTypeForSession,
} from './context-meta.mjs';
import { uncachedInputTokensForProvider } from './usage-metrics.mjs';
import { pruneOffloadSession } from '../tool-result-offload.mjs';
import { _getPendingMessagesForSession } from './pending-messages.mjs';
import { isSessionCompactionBlocked } from './runtime-liveness.mjs';
import {
    compactTargetBudget as compactTargetBudgetForPolicy,
    invalidateProviderContextBaseline,
    resolveWorkerCompactPolicy,
} from '../loop/compact-policy.mjs';

// 'compacting' is a transient in-flight stage written just before semantic /
// recall-fasttrack compaction runs. If the process crashes or only partially
// saves while it is set, a later load/resume reads a session that is NOT
// actually compacting but whose UI marker (App.jsx / ContextPanel) shows
// "Compacting conversation" permanently. Normalize that stale transient stage
// to 'interrupted' so the surface recovers. Terminal stages (post_turn /
// manual / auto_clear / *_failed / overflow_failed) are intentionally left as
// the durable record of the last real outcome.
export function normalizeStaleCompactingStage(session) {
    const c = session?.compaction;
    if (!c || typeof c !== 'object') return false;
    if (c.lastStage !== 'compacting' && c.inProgress !== true) return false;
    c.lastStage = 'interrupted';
    c.inProgress = false;
    c.lastCheckedAt = Date.now();
    return true;
}

// Manual/auto-clear compaction needs the same threshold and post-compact
// target math as the loop, even when automatic compaction is disabled.
export function resolveSessionCompactionPolicy(session) {
    if (!session) return null;
    return resolveWorkerCompactPolicy({
        ...session,
        compaction: { ...(session.compaction || {}), auto: true },
    }, session.tools || []);
}
function addCompactUsageToSession(session, usage) {
    if (!session || !usage) return;
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const cachedTokens = usage.cachedTokens || 0;
    const cacheWriteTokens = usage.cacheWriteTokens || 0;
    const uncachedInputTokens = uncachedInputTokensForProvider(session.provider, inputTokens, cachedTokens, cacheWriteTokens);
    session.totalInputTokens = (session.totalInputTokens || 0) + inputTokens;
    session.totalOutputTokens = (session.totalOutputTokens || 0) + outputTokens;
    session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + cachedTokens;
    session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + cacheWriteTokens;
    session.totalUncachedInputTokens = (session.totalUncachedInputTokens || 0) + uncachedInputTokens;
    session.tokensCumulative = (session.tokensCumulative || 0) + inputTokens + outputTokens;
}
// A dead/unreachable memory runtime makes each proxy RPC wait ~30s (waitForPort)
// and retry once (memory-runtime-proxy.mjs) — that must NEVER wedge the
// compact//clear path. Bound every recall-fasttrack memory call with a short
// local timeout: on timeout we abort (best-effort cancel via a chained signal)
// and treat it exactly like an RPC failure, so compaction proceeds WITHOUT
// recall-fasttrack instead of hanging.
const RECALL_MEMORY_CALL_TIMEOUT_MS = Math.max(
    250,
    Number(process.env.MIXDOG_AGENT_COMPACT_RECALL_TIMEOUT_MS) || 4000,
);
function recallMemoryTimeoutMs(session) {
    const configured = positiveContextWindow(session?.compaction?.recallMemoryTimeoutMs);
    // Clamp ALL sources (session-config included) to the 250ms floor so a
    // misconfigured tiny value can't turn the bound into a busy no-wait.
    return Math.max(250, configured || RECALL_MEMORY_CALL_TIMEOUT_MS);
}
// Cold-start allowance (clear/manual path only): a booting memory daemon can
// miss the tight first bound (waitForPort + first-RPC warmup ~2-10s). On a
// timeout we retry ONCE with a longer bound before honoring the bail-to-
// semantic contract, so a rebooting runtime succeeds instead of instantly
// failing. Non-timeout errors and outer aborts propagate immediately.
// 15s: memory boot is ~2-4s warm-cache / ~10s worst since the PG fast-start
// fix; keeping this tight bounds the clear path's worst case (2 memory calls
// retried + 120s semantic) under the TUI auto-clear watchdog (180s).
const RECALL_COLD_START_TIMEOUT_MS = 15_000;
function isTimeoutError(err) {
    return typeof err?.message === 'string' && err.message.includes('timed out after');
}
async function callMemoryColdStart(args, callerCtx, timeoutMs) {
    try {
        return await callMemoryBounded(args, callerCtx, timeoutMs);
    } catch (err) {
        if (!isTimeoutError(err) || callerCtx?.signal?.aborted) throw err;
        const coldMs = Math.max(timeoutMs, RECALL_COLD_START_TIMEOUT_MS);
        if (coldMs <= timeoutMs) throw err;
        try { process.stderr.write(`[session] recall-fasttrack ${args?.action || 'call'} cold-start retry (${timeoutMs}ms -> ${coldMs}ms)\n`); } catch {}
        return await callMemoryBounded(args, callerCtx, coldMs);
    }
}
// Semantic-compact timeout scales with transcript size (clear/manual path):
// default max(30s, ~10s per 25k estimated message tokens) capped at 120s, so a
// large (~100k-token) transcript no longer dies on a fixed 30s bound.
// session.compaction.timeoutMs still overrides.
function semanticCompactTimeoutMs(session, messageTokens) {
    const override = positiveContextWindow(session?.compaction?.timeoutMs);
    if (override) return override;
    const scaled = Math.ceil((messageTokens || 0) / 25_000) * 10_000;
    return Math.min(120_000, Math.max(30_000, scaled));
}
async function callMemoryBounded(args, callerCtx, timeoutMs) {
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
            executeInternalTool('memory', args, { ...callerCtx, signal: ac.signal }),
            timeout,
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        // Drop the chained-abort listener when the call settles first, so a
        // later outer abort can't fire into a dead controller / leak.
        try { outer?.removeEventListener?.('abort', onOuterAbort); } catch {}
    }
}
async function runRecallFastTrackForSession(session, messages, opts = {}) {
    const sessionId = opts.sessionId || session?.id || null;
    if (!sessionId) throw new Error('recall-fasttrack requires a session id');
    const query = `session:${sessionId}:all-chunks`;
    const querySha = createHash('sha256').update(query).digest('hex').slice(0, 16);
    const callerCtx = {
        callerSessionId: sessionId,
        callerCwd: session?.cwd || undefined,
        routingSessionId: sessionId,
        clientHostPid: session?.clientHostPid,
        signal: opts.signal || null,
    };
    const hydrateLimit = positiveContextWindow(session?.compaction?.recallIngestLimit)
        || Math.max(500, Math.min(5000, messages.length || 0));
    const memoryTimeoutMs = recallMemoryTimeoutMs(session);
    try {
        await callMemoryColdStart({
            action: 'ingest_session',
            sessionId,
            messages,
            cwd: session?.cwd,
            limit: hydrateLimit,
            // Clear/manual-compact path: these rows are about to be summarized
            // away, so skip the bounded 15s synchronous embedding-flush wait —
            // kick the flush fire-and-forget (dense-search immediacy is moot here).
            embedWait: false,
        }, callerCtx, memoryTimeoutMs);
    } catch (err) {
        // Ingest failed (dead/timed-out memory runtime). The transcript is NOT
        // in memory, so recall-fasttrack MUST NOT proceed with a false "history
        // is in memory" digest — that would drop un-ingested head history.
        // Throw so the caller falls back to the normal compaction path.
        try { process.stderr.write(`[session] recall-fasttrack ingest failed — bailing (sess=${sessionId}): ${err?.message || err}\n`); } catch {}
        throw new Error(`recall-fasttrack ingest failed: ${err?.message || err}`);
    }
    // Digest injection (mirrors loop/recall-fasttrack.mjs): no dump + cycle1
    // drain — that ran memory-pipeline LLM chunking inside the compaction.
    // ingest_session above stored the full transcript; background cycle1
    // chunks it on its own schedule and recall serves anything beyond the
    // digest.
    let recallText = '';
    try {
        const browsed = await callMemoryColdStart({
            action: 'search',
            sessionId,
            limit: positiveContextWindow(session?.compaction?.recallDigestLimit) || 30,
            includeMembers: true,
            includeRaw: true,
        }, callerCtx, memoryTimeoutMs);
        recallText = typeof browsed === 'string' ? browsed : String(browsed?.text ?? browsed ?? '');
    } catch (err) {
        // Search failed (dead/timed-out memory runtime). Same hazard as a failed
        // ingest: without a real recall dump we can't safely replace head
        // history — bail out to the normal compaction path.
        try { process.stderr.write(`[session] recall-digest browse failed — bailing (sess=${sessionId}): ${err?.message || err}\n`); } catch {}
        throw new Error(`recall-fasttrack search failed: ${err?.message || err}`);
    }
    return {
        query,
        querySha,
        recallText: [
            `session_id=${sessionId}`,
            // Same byte cap as the loop digest path (recallDigestMaxKb,
            // default = shared tool-output limit) — without it the memory
            // renderer bounds the browse at ~200 rows × 1000 chars, letting a
            // manual//clear compact process a far larger digest than loop's.
            truncateToKb(recallText, positiveContextWindow(session?.compaction?.recallDigestMaxKb) || DIGEST_DEFAULT_MAX_KB),
        ].map(v => String(v || '').trim()).filter(Boolean).join('\n\n'),
    };
}
// Element-identity change detection (same approach as loop.mjs messagesArrayChanged): two
// arrays are "unchanged" only when same length AND every slot is the same object
// reference. Used to reject a no-op prune (which returns a fresh array whose
// elements are the untouched originals) from being accepted as a recovery.
function messagesChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return before !== after;
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) return true;
    }
    return false;
}
export async function runSessionCompaction(session, opts = {}) {
    if (!session || session.closed === true) return null;
    const mode = opts.mode === 'auto' ? 'auto' : 'manual';
    const force = opts.force === true || mode === 'manual';
    if (mode === 'auto' && session.compaction?.auto === false) return null;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (messages.length < 3 && !force) return null;
    const boundary = positiveContextWindow(session.compactBoundaryTokens)
        || positiveContextWindow(session.autoCompactTokenLimit)
        || positiveContextWindow(session.contextWindow);
    if (!boundary) {
        if (force) throw new Error('compact: no context window is available for this session');
        return null;
    }
    // Reserve must mirror loop.mjs (buildCompactPolicy): request reserve (tool
    // schema) PLUS the configured reserve (session.compaction.reservedTokens or
    // MIXDOG_AGENT_COMPACT_RESERVED_TOKENS env). The old request-only value left
    // the manual / auto-clear compact budget without the configured headroom the
    // loop path reserves, so a compacted transcript could overflow on next send.
    const alignedPolicy = resolveSessionCompactionPolicy(session);
    const requestReserveTokens = alignedPolicy?.requestReserveTokens
        ?? estimateRequestReserveTokens(session.tools || []);
    const configuredReserveTokens = alignedPolicy?.configuredReserveTokens
        ?? positiveContextWindow(session.compaction?.reservedTokens)
        ?? positiveContextWindow(process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS)
        ?? 0;
    const reserveTokens = alignedPolicy?.reserveTokens ?? (requestReserveTokens + configuredReserveTokens);
    const beforeMessageTokens = estimateMessagesTokens(messages);
    const triggerTokens = alignedPolicy?.triggerTokens
        || boundary;
    const bufferTokens = alignedPolicy?.bufferTokens ?? Math.max(0, boundary - triggerTokens);
    const bufferRatio = alignedPolicy?.bufferRatio
        ?? (boundary ? (bufferTokens / boundary) : resolveCompactBufferRatio(session.compaction || {}));
    const targetBudgetTokens = alignedPolicy
        ? (compactTargetBudgetForPolicy({ ...alignedPolicy, force }) || boundary)
        : boundary;
    const pressureTokens = estimateTranscriptContextUsage(messages, session.tools || []);
    const beforeTokens = pressureTokens;
    const compactType = compactTypeForSession(session);
    if (!force && pressureTokens < triggerTokens) return {
        changed: false,
        reason: 'below threshold',
        compactType,
        beforeMessages: messages.length,
        afterMessages: messages.length,
        beforeTokens,
        afterTokens: beforeTokens,
        beforeMessageTokens,
        afterMessageTokens: beforeMessageTokens,
        pressureTokens,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        boundaryTokens: boundary,
        budgetTokens: boundary,
        targetBudgetTokens,
        reserveTokens,
        semanticCompact: false,
    };
    const budget = targetBudgetTokens;
    try { await opts.onStageChange?.('compacting'); } catch { /* best-effort */ }
    const provider = opts.provider || getProvider(session.provider) || null;
    let compacted;
    let compactError = null;
    let semanticCompactResult = null;
    let semanticCompactError = null;
    let recallFastTrackResult = null;
    let recallFastTrackError = null;
    if (compactTypeIsRecallFastTrack(compactType)) {
        try {
            const recallPayload = await runRecallFastTrackForSession(session, messages, opts);
            const contextWindow = positiveContextWindow(session.contextWindow) || boundary;
            const recallTokenCap = Math.max(
                RECALL_TOKEN_CAP_FLOOR_TOKENS,
                Math.floor(contextWindow * CONTEXT_SHARE_RATIO),
            );
            recallFastTrackResult = recallFastTrackCompactMessages(messages, budget, {
                reserveTokens,
                force: true,
                recallText: recallPayload.recallText,
                query: recallPayload.query,
                querySha: recallPayload.querySha,
                // Ingest just ran on the live transcript, so an empty recall dump
                // means the memory pipeline is broken — do NOT erase history
                // behind an empty summary shell. Empty recall now throws and is
                // handled by the semantic fallback below (or recorded failure).
                allowEmptyRecall: false,
                tailTurns: positiveContextWindow(session.compaction?.tailTurns) || 2,
                keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens),
                preserveRecentTokens: positiveContextWindow(session.compaction?.preserveRecentTokens),
                recallTokenCap,
            });
            if (Array.isArray(recallFastTrackResult?.messages)) {
                compacted = recallFastTrackResult.messages;
            }
        } catch (err) {
            recallFastTrackError = err;
            compactError = err;
            try {
                process.stderr.write(`[session] recall-fasttrack ${mode} compact failed (sess=${session.id || 'unknown'}): ${err?.message || err}\n`);
            } catch { /* best-effort */ }
            // Degraded-compact fallback: recall-fasttrack failed (empty recall,
            // ingest error, fit failure). Before recording a hard failure, try
            // the semantic path once so auto-clear/manual compaction still makes
            // progress WITHOUT shipping an empty-recall summary. History is only
            // replaced when the semantic summary actually succeeds.
            if (semanticCompactionEnabledForSession(session)
                && provider && typeof provider.send === 'function') {
                try {
                    semanticCompactResult = await semanticCompactMessages(
                        provider,
                        messages,
                        opts.model || session.model,
                        budget,
                        {
                            reserveTokens,
                            providerName: session.provider || provider?.name || null,
                            sessionId: opts.sessionId || session.id || null,
                            signal: opts.signal || null,
                            promptCacheKey: session.promptCacheKey || null,
                            providerCacheKey: session.promptCacheKey || null,
                            timeoutMs: semanticCompactTimeoutMs(session, beforeMessageTokens),
                            tailTurns: positiveContextWindow(session.compaction?.tailTurns) || 2,
                            keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens),
                            preserveRecentTokens: positiveContextWindow(session.compaction?.preserveRecentTokens),
                            force: true,
                        },
                    );
                    if (Array.isArray(semanticCompactResult?.messages)) {
                        compacted = semanticCompactResult.messages;
                        compactError = null;
                        addCompactUsageToSession(session, semanticCompactResult.usage);
                        try {
                            process.stderr.write(`[session] degraded compact: recall-fasttrack failed, semantic fallback succeeded (sess=${session.id || 'unknown'}, mode=${mode})\n`);
                        } catch { /* best-effort */ }
                    }
                } catch (fallbackErr) {
                    semanticCompactError = fallbackErr;
                    try {
                        process.stderr.write(`[session] degraded compact: semantic fallback also failed (sess=${session.id || 'unknown'}): ${fallbackErr?.message || fallbackErr}\n`);
                    } catch { /* best-effort */ }
                }
            }
        }
    } else if (compactTypeIsSemantic(compactType)) {
        try {
            if (!semanticCompactionEnabledForSession(session)) {
                throw new Error('semantic compact is disabled for this session');
            }
            if (!provider || typeof provider.send !== 'function') {
                throw new Error(`semantic compact provider unavailable: ${session.provider || 'unknown'}`);
            }
            semanticCompactResult = await semanticCompactMessages(
                provider,
                messages,
                opts.model || session.model,
                budget,
                {
                    reserveTokens,
                    providerName: session.provider || provider?.name || null,
                    sessionId: opts.sessionId || session.id || null,
                    signal: opts.signal || null,
                    promptCacheKey: session.promptCacheKey || null,
                    providerCacheKey: session.promptCacheKey || null,
                    timeoutMs: semanticCompactTimeoutMs(session, beforeMessageTokens),
                    tailTurns: positiveContextWindow(session.compaction?.tailTurns) || 2,
                    keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens),
                    preserveRecentTokens: positiveContextWindow(session.compaction?.preserveRecentTokens),
                    force: true,
                },
            );
            if (Array.isArray(semanticCompactResult?.messages)) {
                compacted = semanticCompactResult.messages;
                addCompactUsageToSession(session, semanticCompactResult.usage);
            }
        } catch (err) {
            semanticCompactError = err;
            compactError = err;
            try {
                process.stderr.write(`[session] semantic ${mode} compact failed (sess=${session.id || 'unknown'}): ${err?.message || err}\n`);
            } catch { /* best-effort */ }
        }
    }
    if (!compacted && !compactError) {
        compactError = new Error(`${compactType} compact produced no messages`);
    }
    // Anchor-independent prune safety net (mirror loop.mjs compact catch): when a
    // non-recall (semantic) compact failed, try one non-LLM prune that needs no
    // user anchor before recording failure, so Lead manual / auto-clear paths
    // recover the same transcripts the loop path does. Gated off the recall
    // path — a recall failure keeps its original contract (no silent prune).
    if (!compacted && !recallFastTrackError) {
        try {
            const acceptThreshold = compactEffectiveBudget(budget, { reserveTokens });
            const salvaged = pruneToolOutputsUnanchored(messages, budget, { reserveTokens });
            // pruneToolOutputsUnanchored ALWAYS returns a fresh reconciled array
            // (never the input identity), so `salvaged !== messages` is always
            // true and cannot detect a no-op. Compare by element identity so a
            // transcript that already fit (nothing pruned) is NOT falsely accepted
            // as a recovery — that would clear compactError and unconditionally
            // invalidate providerState for an unchanged transcript.
            if (Array.isArray(salvaged)
                && messagesChanged(messages, salvaged)
                && estimateMessagesTokens(salvaged) <= acceptThreshold) {
                compacted = salvaged;
                compactError = null;
                try {
                    process.stderr.write(`[session] compact fallback prune recovered (sess=${session.id || 'unknown'}, mode=${mode})\n`);
                } catch { /* best-effort */ }
            }
        } catch { /* fall through to failure record */ }
    }
    if (!compacted) {
        const now = Date.now();
        session.compaction = {
            ...(session.compaction || {}),
            auto: mode === 'auto' ? true : session.compaction?.auto !== false,
            boundaryTokens: boundary,
            triggerTokens,
            bufferTokens,
            bufferRatio,
            reserveTokens,
            lastStage: mode === 'auto' ? 'post_turn_failed' : 'manual_failed',
            lastBeforeTokens: beforeTokens,
            lastAfterTokens: beforeTokens,
            lastBeforeMessageTokens: beforeMessageTokens,
            lastAfterMessageTokens: beforeMessageTokens,
            lastPressureTokens: pressureTokens,
            lastCheckedAt: now,
            lastChanged: false,
            type: compactType,
            compactType,
            lastCompactType: compactType,
            lastSemantic: false,
            lastSemanticError: semanticCompactError?.message || null,
            lastRecallFastTrack: false,
            lastRecallFastTrackError: recallFastTrackError?.message || null,
            lastError: compactError?.message || semanticCompactError?.message || recallFastTrackError?.message || String(compactError || semanticCompactError || recallFastTrackError || 'compact failed'),
        };
        return {
            changed: false,
            error: session.compaction.lastError,
            compactType,
            beforeMessages: messages.length,
            afterMessages: messages.length,
            beforeTokens,
            afterTokens: beforeTokens,
            beforeMessageTokens,
            afterMessageTokens: beforeMessageTokens,
            pressureTokens,
            triggerTokens,
            bufferTokens,
            bufferRatio,
            boundaryTokens: boundary,
            budgetTokens: boundary,
            targetBudgetTokens: budget,
            reserveTokens,
            semanticCompact: false,
            semanticError: semanticCompactError?.message || null,
            recallFastTrack: false,
            recallFastTrackError: recallFastTrackError?.message || null,
        };
    }
    let beforeEncoded = '';
    let afterEncoded = '';
    try { beforeEncoded = JSON.stringify(messages); } catch { beforeEncoded = ''; }
    try { afterEncoded = JSON.stringify(compacted); } catch { afterEncoded = ''; }
    const afterMessageTokens = estimateMessagesTokens(compacted);
    const afterTokens = afterMessageTokens + reserveTokens;
    const changed = beforeEncoded && afterEncoded
        ? beforeEncoded !== afterEncoded
        : (compacted.length !== messages.length || afterMessageTokens !== beforeMessageTokens);
    const unchangedReason = changed ? null : (force ? 'nothing to compact' : 'below threshold');
    const now = Date.now();
    session.messages = compacted;
    // Best-effort GC only: the 10-minute mtime gate plus this idle-only guard
    // lets an in-flight turn's sidecars survive until a later compaction/close.
    const pruneSessionId = opts.sessionId || session.id;
    if (!isSessionCompactionBlocked(pruneSessionId)) {
        try {
            await pruneOffloadSession(pruneSessionId, () => [
                session.messages,
                session.liveTurnMessages,
                _getPendingMessagesForSession(pruneSessionId),
            ]);
        } catch { /* best-effort */ }
    }
    session.providerState = undefined;
    session.compaction = {
        ...(session.compaction || {}),
        auto: mode === 'auto' ? true : session.compaction?.auto !== false,
        boundaryTokens: boundary,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        reserveTokens,
        type: compactType,
        compactType,
        lastCompactType: compactType,
        lastStage: mode === 'auto' ? 'post_turn' : 'manual',
        lastBeforeTokens: beforeTokens,
        lastAfterTokens: afterTokens,
        lastBeforeMessageTokens: beforeMessageTokens,
        lastAfterMessageTokens: afterMessageTokens,
        lastPressureTokens: pressureTokens,
        lastCheckedAt: now,
        lastChanged: changed,
        lastChangedAt: changed ? now : session.compaction?.lastChangedAt || null,
        lastCompactAt: changed ? now : session.compaction?.lastCompactAt || null,
        lastSemantic: semanticCompactResult?.semantic === true,
        lastSemanticError: semanticCompactError?.message || null,
        lastRecallFastTrack: recallFastTrackResult?.recallFastTrack === true,
        lastRecallFastTrackError: recallFastTrackError?.message || null,
        lastRecallFastTrackQuerySha: recallFastTrackResult?.query ? createHash('sha256').update(recallFastTrackResult.query).digest('hex').slice(0, 16) : null,
        lastSemanticUsage: semanticCompactResult?.usage ? {
            inputTokens: semanticCompactResult.usage.inputTokens || 0,
            outputTokens: semanticCompactResult.usage.outputTokens || 0,
            cachedTokens: semanticCompactResult.usage.cachedTokens || 0,
            cacheWriteTokens: semanticCompactResult.usage.cacheWriteTokens || 0,
        } : null,
        compactCount: (session.compaction?.compactCount || 0) + (changed ? 1 : 0),
    };
    if (changed) invalidateProviderContextBaseline(session);
    return {
        changed,
        reason: unchangedReason,
        compactType,
        beforeMessages: messages.length,
        afterMessages: compacted.length,
        beforeTokens,
        afterTokens,
        beforeMessageTokens,
        afterMessageTokens,
        pressureTokens,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        boundaryTokens: boundary,
        budgetTokens: boundary,
        targetBudgetTokens: budget,
        reserveTokens,
        semanticCompact: semanticCompactResult?.semantic === true,
        semanticError: semanticCompactError?.message || null,
        recallFastTrack: recallFastTrackResult?.recallFastTrack === true,
        recallFastTrackError: recallFastTrackError?.message || null,
        usage: semanticCompactResult?.usage || null,
    };
}
