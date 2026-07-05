// Compaction policy resolution, pressure/target budgeting, telemetry
// persistence, and event emission — extracted from loop.mjs.
// runRecallFastTrackCompact stays in the loop (it drives the recall pipeline
// against live session state).
import {
    estimateRequestReserveTokens,
    resolveCompactBufferRatio,
    resolveCompactBufferTokens,
} from '../context-utils.mjs';
import {
    compactTypeIsRecallFastTrack,
    compactTypeIsSemantic,
    DEFAULT_COMPACT_TYPE,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    CONTEXT_SHARE_RATIO,
    COMPACT_TYPE_RECALL_FASTTRACK,
} from '../compact.mjs';
import { positiveTokenInt, envFlag, envTokenInt } from './env.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';

const COMPACT_SAFETY_PERCENT = 1.00;
// Unified context-share rule (compact/constants.mjs CONTEXT_SHARE_RATIO): the
// post-compaction target is 10% of the boundary/context window — the same 10%
// the recall-fasttrack injection cap uses (loop.mjs recallTokenCap). One
// number governs every "share of model context" budget.
const COMPACT_TARGET_RATIO = CONTEXT_SHARE_RATIO;
const COMPACT_TARGET_MIN_TOKENS = 4_000;

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
        ?? COMPACT_TARGET_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return COMPACT_TARGET_RATIO;
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
    // Only an explicit auto-compact limit STRICTLY BELOW the boundary acts as
    // the trigger. A persisted value == boundary (legacy derived full-window
    // autoCompactTokenLimit) would set autoTriggerTokens == boundary and
    // collapse/override the default trigger, so it is ignored in favor of the
    // default boundary trigger.
    const autoTriggerTokens = autoLimit && autoLimit < compactBoundaryTokens ? Math.max(1, autoLimit) : null;
    // Sanitized explicit limit: only a sub-boundary value is a real auto-compact
    // limit. Anything >= boundary is a legacy derived full-window artifact and
    // is reported as null so rememberCompactTelemetry does not re-persist it
    // back onto the session and re-collapse the buffer on the next turn.
    const explicitAutoCompactTokenLimit = autoTriggerTokens;
    const bufferTokens = autoTriggerTokens
        ? Math.max(0, compactBoundaryTokens - autoTriggerTokens)
        : resolveCompactBufferTokens(compactBoundaryTokens, cfg);
    const bufferRatio = compactBoundaryTokens ? (bufferTokens / compactBoundaryTokens) : resolveCompactBufferRatio(cfg);
    const triggerTokens = autoTriggerTokens || Math.max(1, compactBoundaryTokens - bufferTokens);
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
/** Transcript + request reserve only (never provider lastContextTokens). */
function compactPressureTokens(messageTokensEst, policy) {
    if (messageTokensEst === null) return 0;
    return Math.max(0, messageTokensEst + (policy?.reserveTokens || 0));
}

/** Telemetry pressure when a reactive overflow retry forces the next compact. */
export function compactionTelemetryPressureTokens(messageTokensEst, policy, { reactivePending = false } = {}) {
    const base = compactPressureTokens(messageTokensEst, policy);
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
export function shouldCompactForSession(messageTokensEst, policy, { forceReactive = false } = {}) {
    if (!policy?.auto || !policy.boundaryTokens) return false;
    if (forceReactive) return true;
    if (messageTokensEst === null) return true;
    return compactPressureTokens(messageTokensEst, policy) >= (policy.triggerTokens || policy.boundaryTokens);
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
        sessionRef.lastContextTokensStaleAfterCompact = true;
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
