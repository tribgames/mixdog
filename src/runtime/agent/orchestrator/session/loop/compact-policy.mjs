// Compaction policy resolution, pressure/target budgeting, telemetry
// persistence, and event emission — extracted from loop.mjs.
// runRecallFastTrackCompact stays in the loop (it drives the recall pipeline
// against live session state).
import {
    contextMessagesShapeSignature,
    contextMessagesSignature,
    estimateMessagesTokens,
    estimateRequestReserveTokens,
    providerTokenCalibration,
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
    // default early-trigger buffer (90%); main/user default to full-window
    // trigger (buffer 0 / 100%), still overridable via mainBuffer*;
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
    // Request reserve is provider-visible and belongs in the canonical context
    // value. Operator reserve is local headroom, so preserve its early-compact
    // effect by lowering the threshold instead of inflating displayed usage.
    const singleShot = reserveTokens >= policy.triggerTokens;
    // Main/user recall-fasttrack must not compact into its next trigger. Keep a
    // 1%-of-boundary (up to 1,024-token) gap above the effective post-compact
    // target. Explicit sub-boundary limits and agent semantic triggers retain
    // their established precedence/behavior.
    const minMainTrigger = Math.min(
        compactBoundaryTokens,
        (legacyTargetBudget || 0) + compactTriggerMarginTokens(compactBoundaryTokens),
    );
    const baseTriggerTokens = !singleShot && !isAgentOwner(sessionRef) && !explicitAutoCompactTokenLimit
        ? Math.max(policy.triggerTokens, minMainTrigger)
        : policy.triggerTokens;
    const triggerTokens = Math.max(1, baseTriggerTokens - configuredReserve);
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
        tailTurns: positiveTokenInt(cfg.tailTurns) || envTokenInt('MIXDOG_AGENT_COMPACT_TAIL_TURNS') || 1,
        keepTokens,
        preserveRecentTokens: positiveTokenInt(cfg.preserveRecentTokens) || envTokenInt('MIXDOG_AGENT_COMPACT_PRESERVE_RECENT_TOKENS') || keepTokens,
        reserveTokens,
        requestReserveTokens: requestReserve,
        configuredReserveTokens: configuredReserve,
        provider: sessionRef.provider || null,
        tokenCalibration: providerTokenCalibration(sessionRef.provider),
        toolSchemaSignature: toolSchemaSignature(tools),
    };
}
/**
 * Transcript + request reserve fallback used until an aligned provider
 * baseline exists. The transcript estimate and the serialized-tool-schema
 * reserve are both text the provider tokenizes, so the per-provider billing
 * calibration applies to them; a configured operator reserve is a raw token
 * allowance and stays uncalibrated. With no calibration on the policy the
 * result is the exact legacy sum (estimate + reserveTokens).
 */
function compactPressureTokens(messageTokensEst, policy) {
    if (messageTokensEst === null) return 0;
    const calibration = Number(policy?.tokenCalibration) > 0 ? Number(policy.tokenCalibration) : 1;
    const configured = Math.max(0, Number(policy?.configuredReserveTokens) || 0);
    const totalReserve = Math.max(0, Number(policy?.reserveTokens) || 0);
    // reserveTokens is the caller-facing override (tests/policies may zero it);
    // the request-schema share can never exceed it.
    const requestReserve = Math.min(
        totalReserve,
        Math.max(0, Number(policy?.requestReserveTokens ?? (totalReserve - configured)) || 0),
    );
    const otherReserve = Math.max(0, totalReserve - requestReserve);
    return Math.max(0, Math.round((messageTokensEst + requestReserve) * calibration) + otherReserve);
}

// Provider-visible context estimate without operator-only compaction reserve.
// Request/schema reserve remains included because those bytes are sent to the
// model; configured reserve is merely local headroom and must not inflate the
// user-facing context gauge.
export function currentContextEstimateTokens(messageTokensEst, policy) {
    if (messageTokensEst === null) return 0;
    const calibration = Number(policy?.tokenCalibration) > 0 ? Number(policy.tokenCalibration) : 1;
    const configured = Math.max(0, Number(policy?.configuredReserveTokens) || 0);
    const totalReserve = Math.max(0, Number(policy?.reserveTokens) || 0);
    const requestReserve = Math.min(
        totalReserve,
        Math.max(0, Number(policy?.requestReserveTokens ?? (totalReserve - configured)) || 0),
    );
    return Math.max(0, Math.round((messageTokensEst + requestReserve) * calibration));
}

const CONTEXT_USAGE_SNAPSHOT_VERSION = 1;

function contextUsageSnapshotTail(messages) {
    const tail = Array.isArray(messages) ? messages[messages.length - 1] : null;
    return {
        role: String(tail?.role || ''),
        id: String(tail?.uuid || tail?.id || tail?.toolCallId || ''),
    };
}

export function recordContextUsageSnapshot(sessionRef, policy, {
    messages,
    usedTokens,
    messageTokensEst = null,
    source = 'post_compact',
    updatedAt = Date.now(),
} = {}) {
    if (!sessionRef || !policy || !Array.isArray(messages)) return null;
    const used = Number(usedTokens);
    if (!Number.isFinite(used) || used < 0) return null;
    const messageEstimate = Number.isFinite(Number(messageTokensEst))
        ? Math.max(0, Math.round(Number(messageTokensEst)))
        : estimateMessagesTokens(messages);
    const tail = contextUsageSnapshotTail(messages);
    const snapshot = {
        version: CONTEXT_USAGE_SNAPSHOT_VERSION,
        source: String(source || 'estimated'),
        usedTokens: Math.max(0, Math.round(used)),
        limitTokens: positiveTokenInt(policy.triggerTokens || policy.boundaryTokens) || null,
        messageTokensEst: messageEstimate,
        messageCount: messages.length,
        messagesSignature: contextMessagesSignature(messages),
        tailRole: tail.role,
        tailId: tail.id,
        usageMetricsTurnId: String(sessionRef.usageMetricsTurnId || ''),
        usageMetricsEpoch: Number(sessionRef.usageMetricsEpoch) || 0,
        toolSchemaSignature: policy.toolSchemaSignature || null,
        provider: sessionRef.provider || policy.provider || null,
        model: sessionRef.model || null,
        contextWindow: positiveTokenInt(policy.contextWindow || sessionRef.contextWindow) || null,
        boundaryTokens: positiveTokenInt(policy.boundaryTokens) || null,
        triggerTokens: positiveTokenInt(policy.triggerTokens || policy.boundaryTokens) || null,
        updatedAt: Math.max(0, Math.round(Number(updatedAt) || Date.now())),
    };
    sessionRef.contextUsageSnapshot = snapshot;
    return snapshot;
}

export function resolveContextUsageSnapshot(sessionRef, policy, {
    messages,
} = {}) {
    const snapshot = sessionRef?.contextUsageSnapshot;
    if (!snapshot || typeof snapshot !== 'object'
        || snapshot.version !== CONTEXT_USAGE_SNAPSHOT_VERSION
        || !policy || !Array.isArray(messages)) return null;
    if (String(snapshot.provider || '') !== String(sessionRef?.provider || policy.provider || '')
        || String(snapshot.model || '') !== String(sessionRef?.model || '')) return null;
    if (Number(snapshot.messageCount) !== messages.length
        || String(snapshot.usageMetricsTurnId || '') !== String(sessionRef?.usageMetricsTurnId || '')
        || Number(snapshot.usageMetricsEpoch || 0) !== Number(sessionRef?.usageMetricsEpoch || 0)) return null;
    const tail = contextUsageSnapshotTail(messages);
    if (String(snapshot.tailRole || '') !== tail.role
        || String(snapshot.tailId || '') !== tail.id) return null;
    if (String(snapshot.toolSchemaSignature || '') !== String(policy.toolSchemaSignature || '')
        || Number(snapshot.contextWindow || 0) !== Number(policy.contextWindow || sessionRef?.contextWindow || 0)
        || Number(snapshot.boundaryTokens || 0) !== Number(policy.boundaryTokens || 0)
        || Number(snapshot.triggerTokens || 0) !== Number(policy.triggerTokens || policy.boundaryTokens || 0)) return null;
    const exactSignature = contextMessagesSignature(messages);
    if (String(snapshot.messagesSignature || '') !== exactSignature) {
        // Stored-history media normalization can replace inline payloads with
        // durable placeholders without changing the logical transcript. The
        // stable turn/count/tail anchors above preserve the compact snapshot
        // across that serialization boundary while still invalidating it on
        // ordinary subsequent turns.
        const sameLogicalAnchor = Number(snapshot.messageCount) === messages.length
            && String(snapshot.usageMetricsTurnId || '') === String(sessionRef?.usageMetricsTurnId || '')
            && String(snapshot.tailRole || '') === tail.role
            && String(snapshot.tailId || '') === tail.id;
        if (!sameLogicalAnchor) return null;
    }
    const used = Number(snapshot.usedTokens);
    return Number.isFinite(used) && used >= 0 ? snapshot : null;
}

export function invalidateContextUsageSnapshot(sessionRef) {
    if (!sessionRef || typeof sessionRef !== 'object') return;
    delete sessionRef.contextUsageSnapshot;
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
 * baseline: actual-usage-plus-growth accounting.
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
    invalidateContextUsageSnapshot(sessionRef);
    sessionRef.contextPressureBaselineTokens = tokens;
    sessionRef.contextPressureBaselineOutputTokens = Math.max(0, Math.round(Number(usage?.mainOutputTokens ?? usage?.outputTokens) || 0));
    sessionRef.contextPressureBaselineMessageCount = messages.length;
    sessionRef.contextPressureBaselinePrefixSignature = contextMessagesSignature(messages);
    // Second identity for the same prefix, stable across the disk projection's
    // media placeholders, so a cold reader can still prove this anchor belongs
    // to the transcript it just loaded.
    sessionRef.contextPressureBaselineShapeSignature = contextMessagesShapeSignature(messages);
    sessionRef.contextPressureBaselineProvider = sessionRef.provider || null;
    sessionRef.contextPressureBaselineModel = sessionRef.model || null;
    sessionRef.contextPressureBaselineToolSignature = toolSchemaSignature(sendTools);
    sessionRef.contextPressureBaselineRequestReserveTokens = Math.max(
        0,
        Math.round(estimateRequestReserveTokens(sendTools) * providerTokenCalibration(sessionRef.provider)),
    );
    // provider_send usage arrives before the response's assistant message is
    // appended. Mark that request boundary so pressure resolution skips the
    // first subsequent assistant representation: its output (including opaque
    // reasoningItems/tool calls) is already authoritative provider usage.
    sessionRef.contextPressureBaselineBoundary = boundary === 'request' ? 'request' : 'complete';
    sessionRef.contextPressureBaselineUpdatedAt = Date.now();
    sessionRef.lastContextTokensStaleAfterCompact = false;
    sessionRef.contextPressureBaselineSource = 'provider';
    delete sessionRef.contextPressureUnanchoredAfterRestart;
    delete sessionRef.contextPressureUnanchoredReason;
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
    sessionRef.contextPressureBaselineShapeSignature = null;
    sessionRef.contextPressureBaselineProvider = null;
    sessionRef.contextPressureBaselineModel = null;
    sessionRef.contextPressureBaselineToolSignature = null;
    sessionRef.contextPressureBaselineRequestReserveTokens = null;
    sessionRef.contextPressureBaselineUpdatedAt = null;
    sessionRef.contextPressureBaselineSource = null;
    sessionRef.lastContextTokensStaleAfterCompact = true;
    delete sessionRef.contextPressureUnanchoredAfterRestart;
    delete sessionRef.contextPressureUnanchoredReason;
}

// A baseline is refreshed on every provider_send/turn-end. When the transcript
// has grown but no fresh recording landed for this long, recording is failing
// (zero/absent usage keeps the OLD baseline because record() only returns
// false) — distrust it and fall back to the estimate. An idle session whose
// transcript did NOT grow keeps its baseline regardless of age.
const BASELINE_MAX_STALE_GROWTH_MS = 30 * 60 * 1000;

/**
 * Does this anchor still describe this message prefix?
 *
 * The exact signature is authoritative when it matches. It cannot match after a
 * disk round-trip (stored history carries media placeholders instead of inline
 * payloads), so the shape signature answers that case for anchors recorded with
 * one. Anchors that predate the shape signature can only be judged by the
 * identity guards their caller already applied; trusting them while NOTHING has
 * been appended keeps a real provider reading in charge of a transcript the
 * provider itself measured, instead of handing the gauge to an estimate.
 */
function baselinePrefixMatchesTranscript(sessionRef, messages, count) {
    const stored = String(sessionRef.contextPressureBaselinePrefixSignature || '');
    if (!stored) return false;
    if (stored === contextMessagesSignature(messages, count)) return true;
    const storedShape = String(sessionRef.contextPressureBaselineShapeSignature || '');
    if (storedShape) return storedShape === contextMessagesShapeSignature(messages, count);
    return count === messages.length;
}

function providerBaselinePressureTokens(messages, sessionRef, policy, {
    includeConfiguredReserve = true,
} = {}) {
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
        || !baselinePrefixMatchesTranscript(sessionRef, messages, count)) return null;
    const calibration = Number(policy?.tokenCalibration) > 0 ? Number(policy.tokenCalibration) : 1;
    if (sessionRef.contextPressureBaselineToolSignature !== policy?.toolSchemaSignature) {
        const currentRequestReserve = Math.max(
            0,
            Math.round((Number(policy?.requestReserveTokens) || 0) * calibration),
        );
        const storedRequestReserve = Number(sessionRef.contextPressureBaselineRequestReserveTokens);
        // A changed deferred/control-tool surface does not invalidate provider
        // usage for the aligned message prefix. Adjust only the request-schema
        // share. Legacy snapshots lack the old share, so conservatively add the
        // current one rather than falling back to a gross full-history estimate.
        tokens = Number.isFinite(storedRequestReserve) && storedRequestReserve >= 0
            ? Math.max(0, tokens - Math.round(storedRequestReserve) + currentRequestReserve)
            : tokens + currentRequestReserve;
    }
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
    // Staleness means a baseline that stopped being refreshed WHILE the session
    // kept working — never age on the wall clock. Measured against `now`, this
    // discarded the reading of every session that simply sat unopened for a
    // while (88 of 983 stored sessions), and the whole-transcript estimate that
    // replaced it was the less accurate number in both directions: 1.12x over
    // on the median, 0.82x under on a session already past its window.
    // Comparing against the session's own last activity keeps the rule aimed at
    // its actual target — a live session whose usage recording is failing while
    // its transcript grows — and leaves a session at rest on its measurement.
    const activityAt = Math.max(
        Number(sessionRef.updatedAt) || 0,
        Number(sessionRef.lastContextTokensUpdatedAt) || 0,
    );
    if (messages.length > count && baselineAt > 0
        && (activityAt - baselineAt) > BASELINE_MAX_STALE_GROWTH_MS) return null;
    try {
        // Baseline tokens are authoritative provider billing; only the growth
        // after the baseline is a local estimate and needs billing calibration.
        const growth = count < messages.length
            ? Math.round(estimateMessagesTokens(messages.slice(count)) * calibration)
            : 0;
        const configuredReserve = includeConfiguredReserve
            ? Math.max(0, Number(policy?.configuredReserveTokens) || 0)
            : 0;
        return Math.max(0, tokens + growth + configuredReserve);
    } catch {
        return null;
    }
}

/**
 * Canonical active-context value for display, proactive compaction, and
 * telemetry. Once provider usage exists it is authoritative; only messages
 * appended after that aligned prefix are estimated. The whole-transcript
 * estimate is used only before the first provider reading or after compaction
 * invalidates that reading.
 */
export function resolveContextTokensWithSource(messageTokensEst, policy, { messages, sessionRef } = {}) {
    const baseline = providerBaselinePressureTokens(messages, sessionRef, policy, {
        includeConfiguredReserve: false,
    });
    if (baseline !== null && baseline !== undefined) {
        return { tokens: baseline, source: 'provider' };
    }
    // A crash-recovered transcript whose old provider prefix could not be
    // proven identical keeps the last actual reading for display. It is NOT a
    // proactive-compaction signal: the next real provider response will either
    // refresh the anchor or return an overflow for the existing reactive path.
    if (sessionRef?.contextPressureUnanchoredAfterRestart === true) {
        const lastActual = positiveTokenInt(sessionRef.contextPressureBaselineTokens)
            || positiveTokenInt(sessionRef.lastContextTokens);
        if (lastActual) return { tokens: lastActual, source: 'provider_resume' };
    }
    return {
        tokens: currentContextEstimateTokens(messageTokensEst, policy),
        source: 'estimated',
    };
}

export function resolveContextTokens(messageTokensEst, policy, options = {}) {
    return resolveContextTokensWithSource(messageTokensEst, policy, options).tokens;
}

export function resolveCurrentContextTokens(messageTokensEst, policy, options = {}) {
    return resolveContextTokens(messageTokensEst, policy, options);
}

/**
 * Compatibility names kept for callers while both paths resolve the exact same
 * canonical value.
 */
export function resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef } = {}) {
    return resolveContextTokens(messageTokensEst, policy, { messages, sessionRef });
}

export function resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef } = {}) {
    return resolveContextTokens(messageTokensEst, policy, { messages, sessionRef });
}

/** Telemetry pressure when a reactive overflow retry forces the next compact. */
export function compactionTelemetryPressureTokens(messageTokensEst, policy, {
    reactivePending = false,
    messages,
    sessionRef,
} = {}) {
    const base = resolveContextTokens(messageTokensEst, policy, { messages, sessionRef });
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
    // Resume parity: never destroy durable history from an unanchored local
    // estimate. One provider attempt re-establishes actual usage; a genuine
    // overflow still enters through forceReactive above.
    if (sessionRef?.contextPressureUnanchoredAfterRestart === true) return false;
    // A reserve at/above the trigger (or a one-token boundary)
    // can never satisfy target < trigger. Permit one legacy compact attempt,
    // then suppress automatic repeats until an operator intervenes.
    if (policy.singleShot === true && sessionRef?.compaction?.singleShotConsumed === true) return false;
    if (messageTokensEst === null) return true;
    const pressure = Number.isFinite(Number(pressureTokens))
        ? Number(pressureTokens)
        : resolveContextTokens(messageTokensEst, policy, { messages, sessionRef });
    const trigger = policy.triggerTokens || policy.boundaryTokens;
    if (pressure < trigger) return false;
    // The provider's own accounting outranks a local estimate for a transcript
    // the provider ALREADY measured. When the anchor could not be verified the
    // pressure above is that estimate, and compacting on it destroyed history
    // for sessions running at a quarter of their window. This never suppresses
    // a compaction the growth since that reading could justify: it applies only
    // while NOTHING has been appended, so the two numbers describe one
    // transcript. A genuine overflow still enters through forceReactive above.
    const resolved = resolveContextTokensWithSource(messageTokensEst, policy, { messages, sessionRef });
    if (resolved.source === 'estimated'
        && Number(sessionRef?.contextPressureBaselineMessageCount) === (Array.isArray(messages) ? messages.length : -1)
        && providerReadingBelowTrigger(sessionRef, trigger)) return false;
    return true;
}

/** A last actual prompt size that no compaction has invalidated since. */
function providerReadingBelowTrigger(sessionRef, trigger) {
    const actual = positiveTokenInt(sessionRef?.lastContextTokens);
    if (!actual || !trigger || actual >= trigger) return false;
    if (sessionRef.lastContextTokensStaleAfterCompact === true) return false;
    const compactAt = Number(sessionRef.compaction?.lastChangedAt || sessionRef.compaction?.lastCompactAt || 0);
    const usageAt = Number(sessionRef.lastContextTokensUpdatedAt || 0);
    if (compactAt > 0 && usageAt <= compactAt) return false;
    return true;
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
        // A successful compact has already replaced the transcript. Publishing
        // its pre-compact pressure here made persisted/UI state jump back to
        // ~200k immediately after a 20k result and could be mistaken for a
        // second trigger before contextStatus recomputed. Terminal mutations
        // must expose the post-compact estimate.
        currentEstimatedTokens: changed && meta.stage === 'pre_send'
            ? (meta.afterTokens ?? meta.pressureTokens ?? prev.currentEstimatedTokens ?? null)
            : (meta.pressureTokens ?? prev.currentEstimatedTokens ?? null),
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
            est: meta.messageTokensEst ?? meta.beforeTokens ?? null,
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

// Semantic-summary model override. NO automatic downshift: the runtime cannot
// know which models a given account/gateway can actually serve (an OAuth plan
// or relay may not expose Haiku at all), so guessing a cheaper model risks a
// hard compact failure. The summary runs on the session's own model unless an
// operator explicitly configures compaction.semanticModel (or the
// MIXDOG_AGENT_COMPACT_SEMANTIC_MODEL env) — that opt-in is the only override.
export function resolveSemanticSummaryModel(sessionRef, _opts = {}) {
    const cfg = sessionRef?.compaction && typeof sessionRef.compaction === 'object' ? sessionRef.compaction : {};
    const explicit = String(cfg.semanticModel || '').trim()
        || String(process.env.MIXDOG_AGENT_COMPACT_SEMANTIC_MODEL || '').trim();
    if (explicit) return explicit;
    return null;
}
