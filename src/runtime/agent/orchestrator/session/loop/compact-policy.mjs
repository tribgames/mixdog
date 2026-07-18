// Compaction policy resolution, pressure/target budgeting, telemetry
// persistence, and event emission — extracted from loop.mjs.
// runRecallFastTrackCompact stays in the loop (it drives the recall pipeline
// against live session state).
import {
    contextMessagesSignature,
    estimateMessagesTokens,
    estimateRequestReserveTokens,
    resolveSessionCompactPolicy,
    toolSchemaSignature,
} from '../context-utils.mjs';
import {
    compactTypeIsRecallFastTrack,
    compactTypeIsSemantic,
    DEFAULT_COMPACT_TYPE,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    CONTEXT_SHARE_RATIO,
    COMPACT_TARGET_MIN_TOKENS,
    COMPACT_SAFETY_PERCENT,
    COMPACT_TYPE_RECALL_FASTTRACK,
} from '../compact.mjs';
import { positiveTokenInt, envFlag, envTokenInt } from './env.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { providerInputExcludesCache } from '../../providers/registry.mjs';

// Unified context-share rule (compact/constants.mjs CONTEXT_SHARE_RATIO): the
// post-compaction target is 10% of the boundary/context window — the same 10%
// the recall-fasttrack injection cap uses (loop.mjs recallTokenCap). One
// number governs every "share of model context" budget.

function resolveCompactTypeSetting(sessionRef, cfg = {}) {
    // Agent-owned sessions are ALWAYS semantic. recall-fasttrack rebuilds
    // context from Memory recall, which is scoped to the user's main-session
    // history — an agent's tool-loop history is not in the recall pool, so a
    // fasttrack compact would inject unrelated main-session memories and drop
    // the agent's own working context. Env/config overrides do not apply.
    if (isAgentOwner(sessionRef)) return DEFAULT_COMPACT_TYPE;
    // Non-agent (main/user) sessions are ALWAYS recall-fasttrack. Hard-locked:
    // config/env overrides no longer change the type.
    return COMPACT_TYPE_RECALL_FASTTRACK;
}

function resolveCompactTargetRatio(cfg = {}) {
    const raw = cfg.targetPercent
        ?? cfg.targetPct
        ?? cfg.targetRatio
        ?? cfg.targetFraction
        ?? process.env.MIXDOG_AGENT_COMPACT_TARGET_PERCENT
        ?? process.env.MIXDOG_COMPACT_TARGET_PERCENT
        ?? CONTEXT_SHARE_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return CONTEXT_SHARE_RATIO;
    return n > 1 ? n / 100 : n;
}
function resolveCompactTargetTokens(boundaryTokens, cfg = {}) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return null;
    const explicit = positiveTokenInt(cfg.targetTokens ?? cfg.target)
        || envTokenInt('MIXDOG_AGENT_COMPACT_TARGET_TOKENS')
        || envTokenInt('MIXDOG_COMPACT_TARGET_TOKENS');
    if (explicit) return Math.max(1, Math.min(boundary, explicit));
    const minTarget = Math.min(boundary, positiveTokenInt(cfg.targetMinTokens ?? cfg.minTargetTokens)
        || envTokenInt('MIXDOG_AGENT_COMPACT_TARGET_MIN_TOKENS')
        || envTokenInt('MIXDOG_COMPACT_TARGET_MIN_TOKENS')
        || COMPACT_TARGET_MIN_TOKENS);
    const byRatio = Math.max(1, Math.floor(boundary * resolveCompactTargetRatio(cfg)));
    return Math.max(1, Math.min(boundary, Math.max(minTarget, byRatio)));
}
function resolveCompactKeepTokens(cfg = {}) {
    return positiveTokenInt(cfg.keepTokens ?? cfg.keep?.tokens ?? cfg.preserveRecentTokens)
        || envTokenInt('MIXDOG_AGENT_COMPACT_KEEP_TOKENS')
        || DEFAULT_COMPACTION_KEEP_TOKENS;
}

function compactTriggerMarginTokens(boundaryTokens) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return 1;
    return Math.max(1, Math.min(1_024, Math.floor(boundary * 0.01)));
}

function legacyCompactTargetBudget(boundaryTokens, targetTokens, reserveTokens) {
    const boundary = positiveTokenInt(boundaryTokens);
    if (!boundary) return null;
    return Math.max(1, Math.min(boundary, targetTokens + reserveTokens));
}

function compactTargetBudgetForTrigger(boundaryTokens, targetTokens, reserveTokens, triggerTokens, singleShot = false, force = false) {
    const legacyTarget = legacyCompactTargetBudget(boundaryTokens, targetTokens, reserveTokens);
    const trigger = positiveTokenInt(triggerTokens);
    // Degenerate reserve/window combinations cannot leave any post-compact
    // headroom. Keep the legacy target and let the caller compact once only,
    // rather than inventing a zero/negative margin that would immediately loop.
    if (singleShot || !trigger) return legacyTarget;
    const boundedTarget = Math.max(1, Math.min(legacyTarget, trigger - 1));
    // Forced/manual compaction must retain a viable legacy budget when the
    // strict no-repeat clamp would consume all non-reserve working space.
    return force && boundedTarget <= reserveTokens ? legacyTarget : boundedTarget;
}

export function resolveWorkerCompactPolicy(sessionRef, tools) {
    if (!sessionRef) return null;
    const cfg = sessionRef.compaction || {};
    const auto = cfg.auto !== false && envFlag('MIXDOG_AGENT_COMPACT_AUTO', true);
    if (!auto) return { auto: false };
    const contextWindow = positiveTokenInt(sessionRef.contextWindow ?? cfg.contextWindow);
    const explicitBoundary = positiveTokenInt(sessionRef.compactBoundaryTokens ?? cfg.boundaryTokens);
    const autoLimit = positiveTokenInt(sessionRef.autoCompactTokenLimit ?? cfg.autoCompactTokenLimit);
    const boundaryTokens = explicitBoundary && contextWindow
        ? Math.min(explicitBoundary, contextWindow)
        : (explicitBoundary || contextWindow || autoLimit);
    if (!boundaryTokens) return null;
    const compactBoundaryTokens = Math.max(1, Math.floor(boundaryTokens * COMPACT_SAFETY_PERCENT));
    // Shared session-compaction policy (context-utils): agent semantic keeps the
    // default early-trigger buffer (90%); main/user use their independently
    // configurable 25% default headroom (75%);
    // a truly-explicit sub-boundary limit wins. explicitAutoCompactTokenLimit
    // is the sanitized (null when legacy full-window) value so telemetry never
    // re-persists a boundary-collapsing limit.
    const policy = resolveSessionCompactPolicy(sessionRef, compactBoundaryTokens);
    const explicitAutoCompactTokenLimit = policy.autoCompactTokenLimit;
    const configuredReserve = positiveTokenInt(cfg.reservedTokens)
        || envTokenInt('MIXDOG_AGENT_COMPACT_RESERVED_TOKENS')
        || 0;
    const requestReserve = estimateRequestReserveTokens(tools);
    const reserveTokens = requestReserve + configuredReserve;
    const compactTargetTokens = resolveCompactTargetTokens(compactBoundaryTokens, cfg) || compactBoundaryTokens;
    const legacyTargetBudget = legacyCompactTargetBudget(compactBoundaryTokens, compactTargetTokens, reserveTokens);
    // Reserve is included in every next-send pressure calculation, so its
    // relationship to the actual trigger (not the raw boundary) determines
    // whether a post-compact transcript can ever fall below the trigger.
    const singleShot = reserveTokens >= policy.triggerTokens;
    // Main/user recall-fasttrack must not compact into its next trigger. Keep a
    // 1%-of-boundary (up to 1,024-token) gap above the effective post-compact
    // target. Explicit sub-boundary limits and agent semantic triggers retain
    // their established precedence/behavior.
    const minMainTrigger = Math.min(
        compactBoundaryTokens,
        (legacyTargetBudget || 0) + compactTriggerMarginTokens(compactBoundaryTokens),
    );
    const triggerTokens = !singleShot && !isAgentOwner(sessionRef) && !explicitAutoCompactTokenLimit
        ? Math.max(policy.triggerTokens, minMainTrigger)
        : policy.triggerTokens;
    const bufferTokens = Math.max(0, compactBoundaryTokens - triggerTokens);
    const bufferRatio = bufferTokens / compactBoundaryTokens;
    const keepTokens = resolveCompactKeepTokens(cfg);
    const compactType = resolveCompactTypeSetting(sessionRef, cfg);
    return {
        auto: true,
        type: compactType,
        compactType,
        prune: cfg.prune === true || envFlag('MIXDOG_AGENT_COMPACT_PRUNE', false),
        boundaryTokens: compactBoundaryTokens,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        compactTargetTokens,
        singleShot,
        contextWindow,
        rawContextWindow: positiveTokenInt(sessionRef.rawContextWindow ?? cfg.rawContextWindow) || contextWindow,
        effectiveContextWindowPercent: Number.isFinite(Number(sessionRef.effectiveContextWindowPercent ?? cfg.effectiveContextWindowPercent))
            ? Number(sessionRef.effectiveContextWindowPercent ?? cfg.effectiveContextWindowPercent)
            : null,
        autoCompactTokenLimit: explicitAutoCompactTokenLimit,
        semantic: compactTypeIsSemantic(compactType),
        recallFastTrack: compactTypeIsRecallFastTrack(compactType),
        semanticTimeoutMs: positiveTokenInt(cfg.timeoutMs) || envTokenInt('MIXDOG_AGENT_COMPACT_TIMEOUT_MS') || 30_000,
        tailTurns: positiveTokenInt(cfg.tailTurns) || envTokenInt('MIXDOG_AGENT_COMPACT_TAIL_TURNS') || 2,
        keepTokens,
        preserveRecentTokens: positiveTokenInt(cfg.preserveRecentTokens) || envTokenInt('MIXDOG_AGENT_COMPACT_PRESERVE_RECENT_TOKENS') || keepTokens,
        reserveTokens,
        requestReserveTokens: requestReserve,
        configuredReserveTokens: configuredReserve,
        toolSchemaSignature: toolSchemaSignature(tools),
    };
}
/** Transcript + request reserve fallback used until an aligned provider baseline exists. */
function compactPressureTokens(messageTokensEst, policy) {
    if (messageTokensEst === null) return 0;
    return Math.max(0, messageTokensEst + (policy?.reserveTokens || 0));
}

function providerPressureTokens(sessionRef, usage) {
    if (!usage || typeof usage !== 'object') return 0;
    const input = Math.max(0, Number(usage.mainInputTokens ?? usage.inputTokens) || 0);
    const cachedRead = Math.max(0, Number(usage.mainCachedTokens ?? usage.cachedTokens) || 0);
    const cacheWrite = Math.max(0, Number(usage.mainCacheWriteTokens ?? usage.cacheWriteTokens) || 0);
    const explicitPrompt = Math.max(0, Number(usage.mainPromptTokens ?? usage.promptTokens) || 0);
    const normalizedPrompt = providerInputExcludesCache(sessionRef?.provider)
        ? input + cachedRead + cacheWrite
        : input;
    const prompt = Math.max(explicitPrompt, normalizedPrompt);
    const output = Math.max(0, Number(usage.mainOutputTokens ?? usage.outputTokens) || 0);
    return Math.max(0, Math.round(prompt + output));
}

/**
 * Align an authoritative provider usage snapshot to the message prefix it
 * covers. Later pressure checks add estimates only for messages after this
 * baseline, matching Claude Code's actual-usage-plus-growth accounting.
 */
export function recordProviderContextBaseline(sessionRef, messages, usage, {
    boundary = 'complete',
    sendTools = sessionRef?.tools,
} = {}) {
    if (!sessionRef || !Array.isArray(messages)) return false;
    if (usage?.mainUsageAvailable === false) {
        invalidateProviderContextBaseline(sessionRef);
        return false;
    }
    const tokens = providerPressureTokens(sessionRef, usage);
    if (!tokens) return false;
    sessionRef.contextPressureBaselineTokens = tokens;
    sessionRef.contextPressureBaselineOutputTokens = Math.max(0, Math.round(Number(usage?.mainOutputTokens ?? usage?.outputTokens) || 0));
    sessionRef.contextPressureBaselineMessageCount = messages.length;
    sessionRef.contextPressureBaselinePrefixSignature = contextMessagesSignature(messages);
    sessionRef.contextPressureBaselineProvider = sessionRef.provider || null;
    sessionRef.contextPressureBaselineModel = sessionRef.model || null;
    sessionRef.contextPressureBaselineToolSignature = toolSchemaSignature(sendTools);
    // provider_send usage arrives before the response's assistant message is
    // appended. Mark that request boundary so pressure resolution skips the
    // first subsequent assistant representation: its output (including opaque
    // reasoningItems/tool calls) is already authoritative provider usage.
    sessionRef.contextPressureBaselineBoundary = boundary === 'request' ? 'request' : 'complete';
    sessionRef.contextPressureBaselineUpdatedAt = Date.now();
    sessionRef.lastContextTokensStaleAfterCompact = false;
    return true;
}

/** A changed transcript cannot reuse usage measured against its old prefix. */
export function invalidateProviderContextBaseline(sessionRef) {
    if (!sessionRef) return;
    sessionRef.contextPressureBaselineTokens = null;
    sessionRef.contextPressureBaselineOutputTokens = null;
    sessionRef.contextPressureBaselineMessageCount = null;
    sessionRef.contextPressureBaselineBoundary = null;
    sessionRef.contextPressureBaselinePrefixSignature = null;
    sessionRef.contextPressureBaselineProvider = null;
    sessionRef.contextPressureBaselineModel = null;
    sessionRef.contextPressureBaselineToolSignature = null;
    sessionRef.contextPressureBaselineUpdatedAt = null;
    sessionRef.lastContextTokensStaleAfterCompact = true;
}

function providerBaselinePressureTokens(messages, sessionRef, policy) {
    if (!Array.isArray(messages) || !sessionRef
        || sessionRef.lastContextTokensStaleAfterCompact === true) return null;
    let tokens = positiveTokenInt(sessionRef.contextPressureBaselineTokens);
    const outputTokens = Math.max(0, Number(sessionRef.contextPressureBaselineOutputTokens) || 0);
    let count = Number(sessionRef.contextPressureBaselineMessageCount);
    const baselineAt = Number(sessionRef.contextPressureBaselineUpdatedAt || 0);
    const compactAt = Number(sessionRef.compaction?.lastChangedAt || sessionRef.compaction?.lastCompactAt || 0);
    if (!tokens || !Number.isInteger(count) || count < 0 || count > messages.length
        || (compactAt > 0 && baselineAt > 0 && baselineAt < compactAt)
        || sessionRef.contextPressureBaselineProvider !== (sessionRef.provider || null)
        || sessionRef.contextPressureBaselineModel !== (sessionRef.model || null)
        || sessionRef.contextPressureBaselineToolSignature !== policy?.toolSchemaSignature
        || sessionRef.contextPressureBaselinePrefixSignature !== contextMessagesSignature(messages, count)) return null;
    if (sessionRef.contextPressureBaselineBoundary === 'request') {
        const assistantOffset = messages.slice(count).findIndex(message => message?.role === 'assistant');
        if (assistantOffset >= 0) {
            // The represented assistant is covered by actual output usage.
            count += assistantOffset + 1;
        } else {
            // Empty/thinking-only continuations append no assistant replay.
            // Their output was billed but is absent from the next request, so
            // remove it and estimate every genuinely later message (the nudge).
            tokens = Math.max(0, tokens - outputTokens);
        }
    }
    try {
        const growth = count < messages.length
            ? estimateMessagesTokens(messages.slice(count))
            : 0;
        return Math.max(0, tokens + growth + Math.max(0, Number(policy?.configuredReserveTokens) || 0));
    } catch {
        return null;
    }
}

export function resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef } = {}) {
    return providerBaselinePressureTokens(messages, sessionRef, policy)
        ?? compactPressureTokens(messageTokensEst, policy);
}

/** Telemetry pressure when a reactive overflow retry forces the next compact. */
export function compactionTelemetryPressureTokens(messageTokensEst, policy, {
    reactivePending = false,
    messages,
    sessionRef,
} = {}) {
    const base = resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef });
    if (!reactivePending) return base;
    const floor = positiveTokenInt(policy?.triggerTokens) || positiveTokenInt(policy?.boundaryTokens) || 0;
    return floor ? Math.max(base, floor) : base;
}
export function compactTargetBudget(policy) {
    const boundary = positiveTokenInt(policy?.boundaryTokens);
    if (!boundary) return null;
    const reserve = Math.max(0, Number(policy?.reserveTokens) || 0);
    const targetEffective = positiveTokenInt(policy?.compactTargetTokens)
        || resolveCompactTargetTokens(boundary, policy)
        || boundary;
    const trigger = positiveTokenInt(policy?.triggerTokens);
    const singleShot = policy?.singleShot === true
        || (trigger > 0 && reserve >= trigger);
    return compactTargetBudgetForTrigger(
        boundary,
        targetEffective,
        reserve,
        trigger,
        singleShot,
        policy?.force === true,
    );
}
export function shouldCompactForSession(messageTokensEst, policy, {
    forceReactive = false,
    messages,
    sessionRef,
    pressureTokens,
} = {}) {
    if (!policy?.auto || !policy.boundaryTokens) return false;
    // send-with-recovery permits exactly one context-overflow retry per send
    // (`contextOverflowRetryUsed`), so this can consume at most one additional
    // reactive compact after a one-shot attempt; a second overflow is surfaced.
    if (forceReactive) return true;
    // A reserve at/above the trigger (or a one-token boundary)
    // can never satisfy target < trigger. Permit one legacy compact attempt,
    // then suppress automatic repeats until an operator intervenes.
    if (policy.singleShot === true && sessionRef?.compaction?.singleShotConsumed === true) return false;
    if (messageTokensEst === null) return true;
    const pressure = Number.isFinite(Number(pressureTokens))
        ? Number(pressureTokens)
        : resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef });
    const trigger = policy.triggerTokens || policy.boundaryTokens;
    if (pressure >= trigger) return true;
    // Safety net: the provider-usage baseline exists to correct OVER-counting
    // transcript estimates, so a lower baseline-derived pressure is normally
    // preferred. But a stale/wrong baseline must never SUPPRESS compaction
    // once the raw transcript estimate itself has crossed the trigger — that
    // failure mode let a live session sail past a 950k trigger to 1.1M+ real
    // tokens without a single auto compact. The trigger decision (not the
    // gauge) therefore takes the max of both pressure sources.
    return compactPressureTokens(messageTokensEst, policy) >= trigger;
}
export function countPrunedToolOutputs(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return 0;
    let count = 0;
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i += 1) {
        if (before[i]?.role !== 'tool' || after[i]?.role !== 'tool') continue;
        if (before[i]?.content !== after[i]?.content && after[i]?.compactedKind === 'tool_output_prune') count += 1;
    }
    return count;
}
export function rememberCompactTelemetry(sessionRef, policy, meta = {}) {
    if (!sessionRef || !policy) return;
    const prev = sessionRef.compaction && typeof sessionRef.compaction === 'object'
        ? sessionRef.compaction
        : {};
    const changed = meta.compactChanged === true || meta.pruneCount > 0;
    // Both are successful terminal pre-send states. In particular,
    // pre_send_check is the no-op path after a prior recovered/failing compact;
    // retaining its old component error makes status report a failure although
    // this send's compaction stage completed successfully.
    const terminalSuccess = meta.stage === 'pre_send' || meta.stage === 'pre_send_check';
    sessionRef.compaction = {
        ...prev,
        auto: policy.auto !== false,
        prune: policy.prune === true,
        reservedTokens: policy.configuredReserveTokens || prev.reservedTokens || null,
        requestReserveTokens: policy.requestReserveTokens || 0,
        reserveTokens: policy.reserveTokens || 0,
        boundaryTokens: policy.boundaryTokens || null,
        triggerTokens: policy.triggerTokens || null,
        bufferTokens: policy.bufferTokens || 0,
        bufferRatio: policy.bufferRatio ?? prev.bufferRatio ?? null,
        contextWindow: policy.contextWindow || null,
        rawContextWindow: policy.rawContextWindow || null,
        effectiveContextWindowPercent: policy.effectiveContextWindowPercent ?? null,
        autoCompactTokenLimit: policy.autoCompactTokenLimit || null,
        type: policy.compactType || policy.type || DEFAULT_COMPACT_TYPE,
        compactType: policy.compactType || policy.type || DEFAULT_COMPACT_TYPE,
        semantic: policy.semantic === true ? 'auto' : false,
        recallFastTrack: policy.recallFastTrack === true,
        semanticModel: policy.semanticModel || null,
        semanticTimeoutMs: policy.semanticTimeoutMs || null,
        tailTurns: policy.tailTurns || null,
        keepTokens: policy.keepTokens || null,
        preserveRecentTokens: policy.preserveRecentTokens || null,
        lastCheckedAt: Date.now(),
        lastBeforeTokens: meta.beforeTokens ?? null,
        lastAfterTokens: meta.afterTokens ?? null,
        lastPressureTokens: meta.pressureTokens ?? null,
        currentEstimatedTokens: meta.pressureTokens ?? prev.currentEstimatedTokens ?? null,
        lastApiRequestTokens: positiveTokenInt(sessionRef?.lastContextTokens) || prev.lastApiRequestTokens || null,
        lastStage: meta.stage || prev.lastStage || null,
        lastChanged: changed,
        lastTrigger: meta.trigger || prev.lastTrigger || null,
        lastSemantic: meta.semanticCompact === true,
        lastSemanticError: terminalSuccess
            ? null
            : Object.hasOwn(meta, 'semanticError')
                ? (meta.semanticError ?? null)
                : (prev.lastSemanticError ?? null),
        lastRecallFastTrack: meta.recallFastTrack === true,
        lastRecallFastTrackError: terminalSuccess
            ? null
            : Object.hasOwn(meta, 'recallFastTrackError')
                ? (meta.recallFastTrackError ?? null)
                : (prev.lastRecallFastTrackError ?? null),
        lastError: terminalSuccess
            ? null
            : Object.hasOwn(meta, 'compactError') || Object.hasOwn(meta, 'lastError')
                ? (meta.compactError ?? meta.lastError ?? null)
                : (prev.lastError ?? null),
        lastPruneCount: meta.pruneCount || 0,
        lastDurationMs: meta.durationMs != null && Number.isFinite(Number(meta.durationMs))
            ? Math.max(0, Math.round(Number(meta.durationMs)))
            : null,
        compactCount: (prev.compactCount || 0) + (changed ? 1 : 0),
        singleShotConsumed: policy.singleShot === true && meta.stage === 'compacting'
            ? true
            : prev.singleShotConsumed === true,
    };
    // Postmortem ring buffer: the per-check telemetry above is overwritten on
    // every stage change, which erased all pre-compact evidence when a session
    // blew past its trigger without compacting. Keep the last few decisions
    // (pressure vs estimate vs trigger plus the live baseline) on the session
    // so a missed-trigger incident is diagnosable after the fact.
    {
        const prior = Array.isArray(prev.recentChecks) ? prev.recentChecks : [];
        sessionRef.compaction.recentChecks = [...prior, {
            at: Date.now(),
            stage: meta.stage || null,
            pressure: meta.pressureTokens ?? null,
            est: meta.beforeTokens ?? null,
            trigger: policy.triggerTokens || policy.boundaryTokens || null,
            baseline: positiveTokenInt(sessionRef.contextPressureBaselineTokens) || null,
            baselineAt: Number(sessionRef.contextPressureBaselineUpdatedAt) || null,
        }].slice(-8);
    }
    if (changed) {
        const changedAt = Date.now();
        sessionRef.compaction.lastChangedAt = changedAt;
        sessionRef.compaction.lastCompactAt = changedAt;
        invalidateProviderContextBaseline(sessionRef);
    }
    sessionRef.contextWindow = policy.contextWindow || sessionRef.contextWindow;
    sessionRef.rawContextWindow = policy.rawContextWindow || sessionRef.rawContextWindow;
    sessionRef.compactBoundaryTokens = policy.boundaryTokens || sessionRef.compactBoundaryTokens || null;
    // Persist only the sanitized (sub-boundary) explicit limit. policy.autoCompactTokenLimit
    // is already null for legacy derived full-window values, so a stale
    // boundary-sized autoCompactTokenLimit on the session is cleared here rather
    // than carried forward to re-collapse the buffer next turn.
    {
        const _boundary = positiveTokenInt(sessionRef.compactBoundaryTokens);
        const _prevLimit = positiveTokenInt(sessionRef.autoCompactTokenLimit);
        const _keepPrev = _prevLimit && (!_boundary || _prevLimit < _boundary) ? _prevLimit : null;
        sessionRef.autoCompactTokenLimit = policy.autoCompactTokenLimit || _keepPrev || null;
    }
    if (policy.effectiveContextWindowPercent !== null) {
        sessionRef.effectiveContextWindowPercent = policy.effectiveContextWindowPercent;
    }
}

export function emitCompactEvent(opts, event = {}) {
    if (!opts || typeof opts.onCompactEvent !== 'function') return;
    try { opts.onCompactEvent({ ts: Date.now(), ...event }); }
    catch { /* best-effort UI/log hook */ }
}

export function compactEventType(policy, fallback = DEFAULT_COMPACT_TYPE) {
    return policy?.compactType || policy?.type || fallback;
}
