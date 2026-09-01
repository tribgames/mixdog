// Session compaction runner — one fresh-context Compact contract.
// Extracted verbatim from manager.mjs (behavior-preserving). Self-contained:
// operates on a live `session` object + opts, using pure compact/context
// helpers. No runtime-liveness (_runtimeState) coupling — manager.mjs still
// owns scheduling / stage gating and simply calls runSessionCompaction().
import { getProvider } from '../../providers/registry.mjs';
import { estimateMessagesTokens, estimateRequestReserveTokens, estimateTranscriptContextUsage, resolveCompactBufferRatio } from '../context-utils.mjs';
import { executeInternalTool } from '../../internal-tools.mjs';
import {
    callMemoryColdStart,
    memoryHandoffTimeoutMs,
    runFreshContextCompact,
} from '../loop/fresh-context.mjs';
import {
    positiveContextWindow,
} from './context-meta.mjs';
import { resolveHandoffSummaryModel } from '../loop/compact-policy.mjs';
import { traceAgentCompact, messagePrefixHash } from '../../agent-trace.mjs';
import { uncachedInputTokensForProvider } from './usage-metrics.mjs';
import { pruneOffloadSession } from '../tool-result-offload.mjs';
import { _getPendingMessagesForSession } from './pending-messages.mjs';
import { isSessionCompactionBlocked } from './runtime-liveness.mjs';
import { resetReadStateAfterCompaction } from '../read-dedup.mjs';
import {
    compactTargetBudget as compactTargetBudgetForPolicy,
    currentContextEstimateTokens,
    invalidateProviderContextBaseline,
    recordContextUsageSnapshot,
    resolveGaugeContextTokens,
    resolveWorkerCompactPolicy,
} from '../loop/compact-policy.mjs';
import { snapshotProviderRequestTools } from '../../../../../session-runtime/tool-catalog.mjs';

// 'compacting' is a transient in-flight stage written just before Compact
// runs. If the process crashes or only partially
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
export function resolveSessionCompactionPolicy(session, messages = session?.messages) {
    if (!session) return null;
    const requestTools = snapshotProviderRequestTools({
        provider: session.provider,
        tools: session.tools || [],
        nativeTools: [],
        messages: Array.isArray(messages) ? messages : [],
        session,
    });
    return resolveWorkerCompactPolicy({
        ...session,
        compaction: { ...(session.compaction || {}), auto: true },
    }, requestTools);
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

function withoutLegacyCompactFields(value) {
    const next = value && typeof value === 'object' ? { ...value } : {};
    for (const key of [
        'type',
        'compactType',
        'semantic',
        'semanticModel',
        'semanticTimeoutMs',
        'tailTurns',
        'lastCompactType',
        'lastSemantic',
        'lastSemanticError',
        'lastRecallFastTrack',
        'lastRecallFastTrackError',
        'lastRecallFastTrackQuerySha',
        'lastSemanticUsage',
    ]) delete next[key];
    return next;
}
// Memory bounds live with the fresh-context pipeline, so every caller
// — this one and the pre-send
// compaction — shares one timeout contract instead of each wiring its own.
// Handoff-summary timeout scales with transcript size (clear/manual path):
// default max(30s, ~10s per 25k estimated message tokens) capped at 120s, so a
// large (~100k-token) transcript no longer dies on a fixed 30s bound.
// session.compaction.timeoutMs still overrides.
function handoffSummaryTimeoutMs(session, messageTokens) {
    const override = positiveContextWindow(session?.compaction?.timeoutMs);
    if (override) return override;
    const scaled = Math.ceil((messageTokens || 0) / 25_000) * 10_000;
    return Math.min(120_000, Math.max(30_000, scaled));
}
export async function runSessionCompaction(session, opts = {}) {
    if (!session || session.closed === true) return null;
    const resolvedSessionId = opts.sessionId || session.id || null;
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
    const pressureTokens = estimateTranscriptContextUsage(messages, session.tools || [], { provider: session.provider });
    // Reported before/after are the SAME number the context gauge shows: the
    // provider-billed prompt plus calibrated growth when a baseline is live.
    // pressureTokens stays the trigger numerator, so the compaction decision is
    // unchanged; only the reported scale is aligned.
    const beforeTokens = (alignedPolicy
        ? resolveGaugeContextTokens(beforeMessageTokens, alignedPolicy, { messages, sessionRef: session })
        : 0) || pressureTokens;
    if (!force && pressureTokens < triggerTokens) return {
        changed: false,
        reason: 'below threshold',
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
        freshContext: false,
    };
    const budget = targetBudgetTokens;
    const compactStartedAt = Date.now();
    try { await opts.onStageChange?.('compacting'); } catch { /* best-effort */ }
    const provider = opts.provider || getProvider(session.provider) || null;
    let compacted;
    let compactError = null;
    let freshContextResult = null;
    let freshContextError = null;
    {
        try {
            const contextWindow = positiveContextWindow(session.contextWindow) || boundary;
            const memoryTimeoutMs = memoryHandoffTimeoutMs(session);
            const executeMemory = typeof opts.executeInternalToolFn === 'function'
                ? opts.executeInternalToolFn
                : executeInternalTool;
            freshContextResult = await runFreshContextCompact({
                sessionRef: session,
                messages,
                compactBudgetTokens: budget,
                compactPolicy: {
                    reserveTokens,
                    contextWindow,
                    boundaryTokens: boundary,
                    keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens),
                    preserveRecentTokens: positiveContextWindow(session.compaction?.preserveRecentTokens),
                    handoffTimeoutMs: handoffSummaryTimeoutMs(session, beforeMessageTokens),
                },
                sessionId: resolvedSessionId,
                signal: opts.signal || null,
                provider,
                model: opts.model || resolveHandoffSummaryModel(session, { budgetTokens: budget }) || session.model,
                sendOpts: { session },
                executeMemorySearch: (args, callerCtx) => (
                    callMemoryColdStart(args, callerCtx, memoryTimeoutMs, executeMemory)
                ),
            });
            if (Array.isArray(freshContextResult?.messages)) {
                compacted = freshContextResult.messages;
                addCompactUsageToSession(session, freshContextResult.usage);
            }
        } catch (err) {
            freshContextError = err;
            compactError = err;
            try {
                process.stderr.write(`[session] fresh-context ${mode} compact failed (sess=${session.id || 'unknown'}): ${err?.message || err}\n`);
            } catch { /* best-effort */ }
        }
    }
    if (!compacted && !compactError) {
        compactError = new Error('fresh-context compact produced no messages');
    }
    if (!compacted) {
        const now = Date.now();
        session.compaction = {
            ...withoutLegacyCompactFields(session.compaction),
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
            currentEstimatedTokens: beforeTokens,
            lastCheckedAt: now,
            lastChanged: false,
            lastFreshContext: false,
            lastFreshContextError: freshContextError?.message || null,
            lastError: compactError?.message || freshContextError?.message || String(compactError || freshContextError || 'compact failed'),
        };
        // compact_meta parity with the loop's pre-send pass: the out-of-loop
        // (post-turn/manual) compaction failure was previously invisible to
        // trace analytics.
        traceAgentCompact({
            sessionId: resolvedSessionId,
            stage: mode === 'auto' ? 'post_turn' : 'manual',
            trigger: mode,
            compact_changed: false,
            before_count: messages.length,
            after_count: messages.length,
            context_window: positiveContextWindow(session.contextWindow) || null,
            budget_tokens: boundary,
            boundary_tokens: boundary,
            target_budget_tokens: budget,
            reserve_tokens: reserveTokens,
            pressure_tokens: pressureTokens,
            trigger_tokens: triggerTokens,
            message_tokens_est: beforeMessageTokens,
            duration_ms: Date.now() - compactStartedAt,
            provider: session.provider || null,
            model: session.model || null,
            error: session.compaction.lastError,
            error_code: 'compact_failed',
        });
        return {
            changed: false,
            error: session.compaction.lastError,
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
            freshContext: false,
            freshContextError: freshContextError?.message || null,
        };
    }
    let beforeEncoded = '';
    let afterEncoded = '';
    try { beforeEncoded = JSON.stringify(messages); } catch { beforeEncoded = ''; }
    try { afterEncoded = JSON.stringify(compacted); } catch { afterEncoded = ''; }
    const afterMessageTokens = estimateMessagesTokens(compacted);
    const postCompactPolicy = resolveSessionCompactionPolicy(session, compacted) || alignedPolicy;
    // Same scale as beforeTokens: compaction invalidates the provider baseline,
    // so the gauge's post-compact number is the calibrated transcript estimate
    // plus the request reserve. The raw sum reported roughly half of that.
    const afterTokens = postCompactPolicy
        ? currentContextEstimateTokens(afterMessageTokens, postCompactPolicy)
        : afterMessageTokens + reserveTokens;
    const changed = beforeEncoded && afterEncoded
        ? beforeEncoded !== afterEncoded
        : (compacted.length !== messages.length || afterMessageTokens !== beforeMessageTokens);
    const unchangedReason = changed ? null : (force ? 'nothing to compact' : 'below threshold');
    const now = Date.now();
    session.messages = compacted;
    if (changed) resetReadStateAfterCompaction(resolvedSessionId);
    // Best-effort GC only: the 10-minute mtime gate plus this idle-only guard
    // lets an in-flight turn's sidecars survive until a later compaction/close.
    const pruneSessionId = resolvedSessionId;
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
        ...withoutLegacyCompactFields(session.compaction),
        auto: mode === 'auto' ? true : session.compaction?.auto !== false,
        boundaryTokens: boundary,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        requestReserveTokens: postCompactPolicy?.requestReserveTokens || 0,
        reserveTokens: postCompactPolicy?.reserveTokens ?? reserveTokens,
        lastStage: mode === 'auto' ? 'post_turn' : 'manual',
        lastBeforeTokens: beforeTokens,
        lastAfterTokens: afterTokens,
        lastBeforeMessageTokens: beforeMessageTokens,
        lastAfterMessageTokens: afterMessageTokens,
        lastPressureTokens: pressureTokens,
        currentEstimatedTokens: afterTokens,
        lastCheckedAt: now,
        lastChanged: changed,
        lastChangedAt: changed ? now : session.compaction?.lastChangedAt || null,
        lastCompactAt: changed ? now : session.compaction?.lastCompactAt || null,
        lastFreshContext: freshContextResult?.freshContext === true,
        lastFreshContextError: null,
        lastError: null,
        lastHandoffSource: freshContextResult?.handoffSource || 'memory',
        lastSummaryUsage: freshContextResult?.usage ? {
            inputTokens: freshContextResult.usage.inputTokens || 0,
            outputTokens: freshContextResult.usage.outputTokens || 0,
            cachedTokens: freshContextResult.usage.cachedTokens || 0,
            cacheWriteTokens: freshContextResult.usage.cacheWriteTokens || 0,
        } : null,
        compactCount: (session.compaction?.compactCount || 0) + (changed ? 1 : 0),
    };
    if (changed) {
        invalidateProviderContextBaseline(session);
        if (postCompactPolicy) {
            recordContextUsageSnapshot(session, postCompactPolicy, {
                messages: compacted,
                usedTokens: afterTokens,
                messageTokensEst: afterMessageTokens,
                source: 'post_compact',
                updatedAt: now,
            });
        }
    }
    // Observability parity with the loop's pre-send pass: record the
    // out-of-loop mutation as compact_meta and park a one-shot intent so the
    // next turn's first send tags its cache break instead of logging an
    // unexplained input_prefix_mismatch (observed live: a 403k→10k post-turn
    // compact traced as intentional_transition: null with no compact_meta).
    let beforePrefixHash = null;
    try { beforePrefixHash = messagePrefixHash(messages); } catch { /* best-effort */ }
    traceAgentCompact({
        sessionId: pruneSessionId || null,
        stage: mode === 'auto' ? 'post_turn' : 'manual',
        trigger: mode,
        compact_changed: changed,
        input_prefix_hash: beforePrefixHash,
        before_count: messages.length,
        after_count: compacted.length,
        before_bytes: beforeEncoded ? Buffer.byteLength(beforeEncoded, 'utf8') : null,
        after_bytes: afterEncoded ? Buffer.byteLength(afterEncoded, 'utf8') : null,
        context_window: positiveContextWindow(session.contextWindow) || null,
        budget_tokens: boundary,
        boundary_tokens: boundary,
        target_budget_tokens: budget,
        reserve_tokens: reserveTokens,
        pressure_tokens: pressureTokens,
        trigger_tokens: triggerTokens,
        message_tokens_est: beforeMessageTokens,
        duration_ms: Date.now() - compactStartedAt,
        provider: session.provider || null,
        model: session.model || null,
    });
    if (changed) {
        session.pendingCacheBreakIntent = mode === 'auto' ? 'post_turn_compaction' : 'manual_compaction';
    }
    return {
        changed,
        reason: unchangedReason,
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
        freshContext: freshContextResult?.freshContext === true,
        freshContextError: null,
        handoffSource: freshContextResult?.handoffSource || 'memory',
        usage: freshContextResult?.usage || null,
    };
}
