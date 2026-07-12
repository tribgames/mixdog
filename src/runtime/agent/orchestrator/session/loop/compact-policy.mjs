// Compaction policy resolution, pressure/target budgeting, telemetry
// persistence, and event emission — extracted from loop.mjs.
// runRecallFastTrackCompact stays in the loop (it drives the recall pipeline
// against live session state).
import {
    estimateMessagesTokens,
    estimateRequestReserveTokens,
    resolveSessionCompactPolicy,
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

function resolveSemanticCompactSetting(sessionRef, cfg = {}) {
    // Types are hard-locked (agent -> semantic, main/user -> recall-fasttrack).
    // Semantic must always be available as a compact path or agent sessions
    // would have none (loop.mjs throws when no type is available). Env/cfg
    // off-switches no longer apply.
    void sessionRef;
    void cfg;
    return true;
}

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
    // default early-trigger buffer (90%); main/user keep 5% headroom (95%);
    // a truly-explicit sub-boundary limit wins. explicitAutoCompactTokenLimit
    // is the sanitized (null when legacy full-window) value so telemetry never
    // re-persists a boundary-collapsing limit.
    const policy = resolveSessionCompactPolicy(sessionRef, compactBoundaryTokens);
    const explicitAutoCompactTokenLimit = policy.autoCompactTokenLimit;
    const bufferTokens = policy.bufferTokens;
    const bufferRatio = policy.bufferRatio;
    const triggerTokens = policy.triggerTokens;
    const configuredReserve = positiveTokenInt(cfg.reservedTokens)
        || envTokenInt('MIXDOG_AGENT_COMPACT_RESERVED_TOKENS')
        || 0;
    const requestReserve = estimateRequestReserveTokens(tools);
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
        contextWindow,
        rawContextWindow: positiveTokenInt(sessionRef.rawContextWindow ?? cfg.rawContextWindow) || contextWindow,
        effectiveContextWindowPercent: Number.isFinite(Number(sessionRef.effectiveContextWindowPercent ?? cfg.effectiveContextWindowPercent))
            ? Number(sessionRef.effectiveContextWindowPercent ?? cfg.effectiveContextWindowPercent)
            : null,
        autoCompactTokenLimit: explicitAutoCompactTokenLimit,
        semantic: compactTypeIsSemantic(compactType) && resolveSemanticCompactSetting(sessionRef, cfg),
        recallFastTrack: compactTypeIsRecallFastTrack(compactType),
        semanticTimeoutMs: positiveTokenInt(cfg.timeoutMs) || envTokenInt('MIXDOG_AGENT_COMPACT_TIMEOUT_MS') || 30_000,
        tailTurns: positiveTokenInt(cfg.tailTurns) || envTokenInt('MIXDOG_AGENT_COMPACT_TAIL_TURNS') || 2,
        keepTokens,
        preserveRecentTokens: positiveTokenInt(cfg.preserveRecentTokens) || envTokenInt('MIXDOG_AGENT_COMPACT_PRESERVE_RECENT_TOKENS') || keepTokens,
        reserveTokens: requestReserve + configuredReserve,
        requestReserveTokens: requestReserve,
        configuredReserveTokens: configuredReserve,
    };
}
/** Transcript + request reserve fallback used until an aligned provider baseline exists. */
function compactPressureTokens(messageTokensEst, policy) {
    if (messageTokensEst === null) return 0;
    return Math.max(0, messageTokensEst + (policy?.reserveTokens || 0));
}

function providerPressureTokens(sessionRef, usage) {
    if (!usage || typeof usage !== 'object') return 0;
    const input = Math.max(0, Number(usage.inputTokens) || 0);
    const cachedRead = Math.max(0, Number(usage.cachedTokens) || 0);
    const cacheWrite = Math.max(0, Number(usage.cacheWriteTokens) || 0);
    const explicitPrompt = Math.max(0, Number(usage.promptTokens) || 0);
    const normalizedPrompt = providerInputExcludesCache(sessionRef?.provider)
        ? input + cachedRead + cacheWrite
        : input;
    const prompt = Math.max(explicitPrompt, normalizedPrompt);
    const output = Math.max(0, Number(usage.outputTokens) || 0);
    return Math.max(0, Math.round(prompt + output));
}

/**
 * Align an authoritative provider usage snapshot to the message prefix it
 * covers. Later pressure checks add estimates only for messages after this
 * baseline, matching Claude Code's actual-usage-plus-growth accounting.
 */
export function recordProviderContextBaseline(sessionRef, messages, usage, { boundary = 'complete' } = {}) {
    if (!sessionRef || !Array.isArray(messages)) return false;
    const tokens = providerPressureTokens(sessionRef, usage);
    if (!tokens) return false;
    sessionRef.contextPressureBaselineTokens = tokens;
    sessionRef.contextPressureBaselineOutputTokens = Math.max(0, Math.round(Number(usage?.outputTokens) || 0));
    sessionRef.contextPressureBaselineMessageCount = messages.length;
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
    sessionRef.contextPressureBaselineUpdatedAt = null;
    sessionRef.lastContextTokensStaleAfterCompact = true;
}

function providerBaselinePressureTokens(messages, sessionRef) {
    if (!Array.isArray(messages) || !sessionRef
        || sessionRef.lastContextTokensStaleAfterCompact === true) return null;
    let tokens = positiveTokenInt(sessionRef.contextPressureBaselineTokens);
    const outputTokens = Math.max(0, Number(sessionRef.contextPressureBaselineOutputTokens) || 0);
    let count = Number(sessionRef.contextPressureBaselineMessageCount);
    const baselineAt = Number(sessionRef.contextPressureBaselineUpdatedAt || 0);
    const compactAt = Number(sessionRef.compaction?.lastChangedAt || sessionRef.compaction?.lastCompactAt || 0);
    if (!tokens || !Number.isInteger(count) || count < 0 || count > messages.length
        || (compactAt > 0 && baselineAt > 0 && baselineAt < compactAt)) return null;
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
        return Math.max(0, tokens + growth);
    } catch {
        return null;
    }
}

export function resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef } = {}) {
    return providerBaselinePressureTokens(messages, sessionRef)
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
    const targetEffective = resolveCompactTargetTokens(boundary, policy) || boundary;
    return Math.max(1, Math.min(boundary, targetEffective + reserve));
}
export function shouldCompactForSession(messageTokensEst, policy, {
    forceReactive = false,
    messages,
    sessionRef,
    pressureTokens,
} = {}) {
    if (!policy?.auto || !policy.boundaryTokens) return false;
    if (forceReactive) return true;
    if (messageTokensEst === null) return true;
    const pressure = Number.isFinite(Number(pressureTokens))
        ? Number(pressureTokens)
        : resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef });
    return pressure >= (policy.triggerTokens || policy.boundaryTokens);
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
        lastSemanticError: Object.hasOwn(meta, 'semanticError')
            ? (meta.semanticError ?? null)
            : (prev.lastSemanticError ?? null),
        lastRecallFastTrack: meta.recallFastTrack === true,
        lastRecallFastTrackError: Object.hasOwn(meta, 'recallFastTrackError')
            ? (meta.recallFastTrackError ?? null)
            : (prev.lastRecallFastTrackError ?? null),
        lastError: Object.hasOwn(meta, 'compactError') || Object.hasOwn(meta, 'lastError')
            ? (meta.compactError ?? meta.lastError ?? null)
            : (prev.lastError ?? null),
        lastPruneCount: meta.pruneCount || 0,
        lastDurationMs: meta.durationMs != null && Number.isFinite(Number(meta.durationMs))
            ? Math.max(0, Math.round(Number(meta.durationMs)))
            : null,
        compactCount: (prev.compactCount || 0) + (changed ? 1 : 0),
    };
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
