// Session compaction runner — one fresh-context Compact contract.
// Self-contained: operates on a live `session` object + opts, using pure
// compact/context helpers. No runtime-liveness (_runtimeState) coupling —
// manager.mjs still owns scheduling / stage gating and simply calls
// runSessionCompaction().
import { getProvider } from '../../providers/registry.mjs';
import { HANDOFF_TIMEOUT_MAX_MS } from '../compact/constants.mjs';
import {
  estimateMessagesTokens,
  estimateRequestReserveTokens,
  estimateTranscriptContextUsage,
  resolveCompactBufferRatio,
} from '../context-utils.mjs';
import { runFreshContextCompact } from '../loop/fresh-context.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
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
  return resolveWorkerCompactPolicy(
    {
      ...session,
      compaction: { ...(session.compaction || {}), auto: true },
    },
    requestTools
  );
}
function addCompactUsageToSession(session, usage, provider = session?.provider) {
  if (!session || !usage) return;
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cachedTokens = usage.cachedTokens || 0;
  const cacheWriteTokens = usage.cacheWriteTokens || 0;
  const uncachedInputTokens = uncachedInputTokensForProvider(provider, inputTokens, cachedTokens, cacheWriteTokens);
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
  ])
    delete next[key];
  return next;
}
// Handoff-summary timeout scales with transcript size (clear/manual path):
// default max(60s, ~10s per 25k estimated message tokens) capped at 300s.
// The summary may run on a slow reasoning model — the session's own model is
// used whenever the maintenance route is unavailable — where even a small
// transcript outlives the old 30s floor and a large one the old 120s cap.
// session.compaction.timeoutMs still overrides.
function handoffSummaryTimeoutMs(session, messageTokens) {
  const override = positiveInt(session?.compaction?.timeoutMs);
  if (override) return override;
  const scaled = Math.ceil((messageTokens || 0) / 25_000) * 10_000;
  return Math.min(HANDOFF_TIMEOUT_MAX_MS, Math.max(60_000, scaled));
}
/**
 * ONE wiring for the fresh-context handoff pass: provider, summary model,
 * isolated summary call and the timeout that scales with the transcript.
 *
 * It is pure with respect to the session — new messages come back, nothing is
 * mutated and nothing is persisted — so a caller may compact a COPY of a
 * conversation. Session inheritance relies on exactly that: an oversized
 * transcript is compacted for the heir while the session that owns it keeps
 * every message (user: 자동으로 컴팩트하고 승계).
 */
export async function runHandoffCompaction({
  session,
  messages,
  budgetTokens,
  boundaryTokens,
  reserveTokens,
  contextWindow = null,
  sessionId = null,
  signal = null,
  provider = null,
  model = null,
  config,
  messageTokensEst = null,
} = {}) {
  const messageList = Array.isArray(messages) ? messages : [];
  const transcriptTokens = Number.isFinite(Number(messageTokensEst))
    ? Number(messageTokensEst)
    : estimateMessagesTokens(messageList);
  return runFreshContextCompact({
    sessionRef: session,
    messages,
    compactBudgetTokens: budgetTokens,
    compactPolicy: {
      reserveTokens,
      contextWindow: positiveInt(contextWindow) || positiveInt(session?.contextWindow) || boundaryTokens,
      boundaryTokens,
      handoffTimeoutMs: handoffSummaryTimeoutMs(session, transcriptTokens),
    },
    sessionId,
    signal,
    config,
    provider: provider || getProvider(session?.provider) || null,
    model: model || resolveHandoffSummaryModel(session, { budgetTokens }) || session?.model,
    sendOpts: { session },
  });
}

// Everything the pass settles before deciding to run: mode, the aligned
// policy and the token numbers every stage reports from. Null = nothing to
// do for this session.
function sessionCompactionPlan(session, opts) {
  const resolvedSessionId = opts.sessionId || session.id || null;
  const mode = opts.mode === 'auto' ? 'auto' : 'manual';
  const force = opts.force === true || mode === 'manual';
  if (mode === 'auto' && session.compaction?.auto === false) return null;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (messages.length < 3 && !force) return null;
  const boundary =
    positiveInt(session.compactBoundaryTokens) ||
    positiveInt(session.autoCompactTokenLimit) ||
    positiveInt(session.contextWindow);
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
  return {
    session,
    resolvedSessionId,
    mode,
    force,
    messages,
    boundary,
    alignedPolicy,
    reserveTokens: compactionReserveTokens(session, alignedPolicy),
    ...compactionPlanNumbers({ session, messages, boundary, alignedPolicy, force }),
  };
}

function compactionReserveTokens(session, alignedPolicy) {
  const requestReserveTokens = alignedPolicy?.requestReserveTokens ?? estimateRequestReserveTokens(session.tools || []);
  const configuredReserveTokens =
    alignedPolicy?.configuredReserveTokens ??
    positiveInt(session.compaction?.reservedTokens) ??
    positiveInt(process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS) ??
    0;
  return alignedPolicy?.reserveTokens ?? requestReserveTokens + configuredReserveTokens;
}

// The trigger, buffer, budget and before numbers a pass reports from.
// Reported before/after are the SAME number the context gauge shows: the
// provider-billed prompt plus calibrated growth when a baseline is live.
// pressureTokens stays the trigger numerator, so the compaction decision is
// unchanged; only the reported scale is aligned.
function compactionPlanNumbers({ session, messages, boundary, alignedPolicy, force }) {
  const beforeMessageTokens = estimateMessagesTokens(messages);
  const triggerTokens = alignedPolicy?.triggerTokens || boundary;
  const bufferTokens = alignedPolicy?.bufferTokens ?? Math.max(0, boundary - triggerTokens);
  const bufferRatio =
    alignedPolicy?.bufferRatio ??
    (boundary ? bufferTokens / boundary : resolveCompactBufferRatio(session.compaction || {}));
  const budget = alignedPolicy ? compactTargetBudgetForPolicy({ ...alignedPolicy, force }) || boundary : boundary;
  const pressureTokens = estimateTranscriptContextUsage(messages, session.tools || [], { provider: session.provider });
  const beforeTokens =
    (alignedPolicy
      ? resolveGaugeContextTokens(beforeMessageTokens, alignedPolicy, { messages, sessionRef: session })
      : 0) || pressureTokens;
  return { beforeMessageTokens, triggerTokens, bufferTokens, bufferRatio, budget, pressureTokens, beforeTokens };
}

// The post-compaction numbers of a pass that left the transcript alone.
function unchangedAfter(plan) {
  return { messages: plan.messages.length, tokens: plan.beforeTokens, messageTokens: plan.beforeMessageTokens };
}

function compactionResult(plan, outcome, after, tail) {
  return {
    ...outcome,
    beforeMessages: plan.messages.length,
    afterMessages: after.messages,
    beforeTokens: plan.beforeTokens,
    afterTokens: after.tokens,
    beforeMessageTokens: plan.beforeMessageTokens,
    afterMessageTokens: after.messageTokens,
    pressureTokens: plan.pressureTokens,
    triggerTokens: plan.triggerTokens,
    bufferTokens: plan.bufferTokens,
    bufferRatio: plan.bufferRatio,
    boundaryTokens: plan.boundary,
    budgetTokens: plan.boundary,
    targetBudgetTokens: plan.budget,
    reserveTokens: plan.reserveTokens,
    ...tail,
  };
}

function compactionRecord(plan, { stage, after, now, reserve, outcome }) {
  const { session, mode } = plan;
  return {
    ...withoutLegacyCompactFields(session.compaction),
    auto: mode === 'auto' ? true : session.compaction?.auto !== false,
    boundaryTokens: plan.boundary,
    triggerTokens: plan.triggerTokens,
    bufferTokens: plan.bufferTokens,
    bufferRatio: plan.bufferRatio,
    ...reserve,
    lastStage: stage,
    lastBeforeTokens: plan.beforeTokens,
    lastAfterTokens: after.tokens,
    lastBeforeMessageTokens: plan.beforeMessageTokens,
    lastAfterMessageTokens: after.messageTokens,
    lastPressureTokens: plan.pressureTokens,
    currentEstimatedTokens: after.tokens,
    lastCheckedAt: now,
    ...outcome,
  };
}

// compact_meta parity with the loop's pre-send pass: the out-of-loop
// (post-turn/manual) compaction — and its failure — used to be invisible to
// trace analytics.
function traceSessionCompaction(plan, compactStartedAt, { counts, failure }) {
  const { session, mode } = plan;
  traceAgentCompact({
    sessionId: plan.resolvedSessionId,
    stage: mode === 'auto' ? 'post_turn' : 'manual',
    trigger: mode,
    ...counts,
    context_window: positiveInt(session.contextWindow) || null,
    budget_tokens: plan.boundary,
    boundary_tokens: plan.boundary,
    target_budget_tokens: plan.budget,
    reserve_tokens: plan.reserveTokens,
    pressure_tokens: plan.pressureTokens,
    trigger_tokens: plan.triggerTokens,
    message_tokens_est: plan.beforeMessageTokens,
    duration_ms: Date.now() - compactStartedAt,
    provider: session.provider || null,
    model: session.model || null,
    ...failure,
  });
}

async function runSessionHandoff(plan, opts) {
  const { session, messages, mode } = plan;
  const run = { compacted: null, compactError: null, freshContextResult: null, freshContextError: null };
  try {
    run.freshContextResult = await runHandoffCompaction({
      session,
      messages,
      budgetTokens: plan.budget,
      boundaryTokens: plan.boundary,
      reserveTokens: plan.reserveTokens,
      contextWindow: positiveInt(session.contextWindow) || plan.boundary,
      sessionId: plan.resolvedSessionId,
      signal: opts.signal || null,
      provider: opts.provider || getProvider(session.provider) || null,
      model: opts.model,
      config: opts.config,
      messageTokensEst: plan.beforeMessageTokens,
    });
    if (Array.isArray(run.freshContextResult?.messages)) {
      run.compacted = run.freshContextResult.messages;
      addCompactUsageToSession(session, run.freshContextResult.usage, run.freshContextResult.summaryProvider);
    }
  } catch (err) {
    run.freshContextError = err;
    run.compactError = err;
    try {
      process.stderr.write(
        `[session] fresh-context ${mode} compact failed (sess=${session.id || 'unknown'}): ${err?.message || err}\n`
      );
    } catch {
      /* best-effort */
    }
  }
  if (!run.compacted && !run.compactError) {
    run.compactError = new Error('fresh-context compact produced no messages');
  }
  return run;
}

function recordFailedCompaction(plan, run, compactStartedAt) {
  const { session, mode, messages } = plan;
  const { compactError, freshContextError } = run;
  session.compaction = compactionRecord(plan, {
    stage: mode === 'auto' ? 'post_turn_failed' : 'manual_failed',
    after: unchangedAfter(plan),
    now: Date.now(),
    reserve: { reserveTokens: plan.reserveTokens },
    outcome: {
      lastChanged: false,
      lastFreshContext: false,
      lastFreshContextError: freshContextError?.message || null,
      lastError:
        compactError?.message ||
        freshContextError?.message ||
        String(compactError || freshContextError || 'compact failed'),
    },
  });
  traceSessionCompaction(plan, compactStartedAt, {
    counts: { compact_changed: false, before_count: messages.length, after_count: messages.length },
    failure: { error: session.compaction.lastError, error_code: 'compact_failed' },
  });
  return compactionResult(plan, { changed: false, error: session.compaction.lastError }, unchangedAfter(plan), {
    freshContext: false,
    freshContextError: freshContextError?.message || null,
  });
}

function encodedOrEmpty(messages) {
  try {
    return JSON.stringify(messages);
  } catch {
    return '';
  }
}

// Best-effort GC only: the 10-minute mtime gate plus this idle-only guard
// lets an in-flight turn's sidecars survive until a later compaction/close.
async function pruneCompactedOffloads(session, sessionId) {
  if (isSessionCompactionBlocked(sessionId)) return;
  try {
    await pruneOffloadSession(sessionId, () => [
      session.messages,
      session.liveTurnMessages,
      _getPendingMessagesForSession(sessionId),
    ]);
  } catch {
    /* best-effort */
  }
}

function summaryUsageRecord(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cachedTokens: usage.cachedTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
  };
}

function compactionOutcome(session, freshContextResult, changed, now) {
  return {
    lastChanged: changed,
    lastChangedAt: changed ? now : session.compaction?.lastChangedAt || null,
    lastCompactAt: changed ? now : session.compaction?.lastCompactAt || null,
    lastFreshContext: freshContextResult?.freshContext === true,
    lastFreshContextError: null,
    lastError: null,
    lastHandoffSource: freshContextResult?.handoffSource || 'session-local',
    lastSummaryProvider: freshContextResult?.summaryProvider || null,
    lastSummaryModel: freshContextResult?.summaryModel || null,
    lastSummaryUsage: summaryUsageRecord(freshContextResult?.usage),
    compactCount: (session.compaction?.compactCount || 0) + (changed ? 1 : 0),
  };
}

// Observability parity with the loop's pre-send pass: record the
// out-of-loop mutation as compact_meta (observed live: a 403k→10k post-turn
// compact traced as intentional_transition: null with no compact_meta).
function traceCommittedCompaction(
  plan,
  compactStartedAt,
  { messages, compacted, beforeEncoded, afterEncoded, changed }
) {
  let beforePrefixHash = null;
  try {
    beforePrefixHash = messagePrefixHash(messages);
  } catch {
    /* best-effort */
  }
  traceSessionCompaction(plan, compactStartedAt, {
    counts: {
      compact_changed: changed,
      input_prefix_hash: beforePrefixHash,
      before_count: messages.length,
      after_count: compacted.length,
      before_bytes: beforeEncoded ? Buffer.byteLength(beforeEncoded, 'utf8') : null,
      after_bytes: afterEncoded ? Buffer.byteLength(afterEncoded, 'utf8') : null,
    },
  });
}

// The post-compaction numbers and whether the transcript actually changed.
// afterTokens is on the same scale as beforeTokens: compaction invalidates
// the provider baseline, so the gauge's post-compact number is the
// calibrated transcript estimate plus the request reserve. The raw sum
// reported roughly half of that.
function afterCompactionNumbers(plan, compacted) {
  const { session, messages, reserveTokens } = plan;
  const beforeEncoded = encodedOrEmpty(messages);
  const afterEncoded = encodedOrEmpty(compacted);
  const afterMessageTokens = estimateMessagesTokens(compacted);
  const postCompactPolicy = resolveSessionCompactionPolicy(session, compacted) || plan.alignedPolicy;
  const afterTokens = postCompactPolicy
    ? currentContextEstimateTokens(afterMessageTokens, postCompactPolicy)
    : afterMessageTokens + reserveTokens;
  const changed =
    beforeEncoded && afterEncoded
      ? beforeEncoded !== afterEncoded
      : compacted.length !== messages.length || afterMessageTokens !== plan.beforeMessageTokens;
  return { beforeEncoded, afterEncoded, afterMessageTokens, postCompactPolicy, afterTokens, changed };
}

async function commitSessionCompaction(plan, run, compactStartedAt) {
  const { session, messages, mode, force, resolvedSessionId, reserveTokens } = plan;
  const { compacted, freshContextResult } = run;
  const { beforeEncoded, afterEncoded, afterMessageTokens, postCompactPolicy, afterTokens, changed } =
    afterCompactionNumbers(plan, compacted);
  let unchangedReason = null;
  if (!changed) unchangedReason = force ? 'nothing to compact' : 'below threshold';
  const now = Date.now();
  session.messages = compacted;
  if (changed) resetReadStateAfterCompaction(resolvedSessionId);
  await pruneCompactedOffloads(session, resolvedSessionId);
  if (changed) session.providerState = undefined;
  session.compaction = compactionRecord(plan, {
    stage: mode === 'auto' ? 'post_turn' : 'manual',
    after: { tokens: afterTokens, messageTokens: afterMessageTokens },
    now,
    reserve: {
      requestReserveTokens: postCompactPolicy?.requestReserveTokens || 0,
      reserveTokens: postCompactPolicy?.reserveTokens ?? reserveTokens,
    },
    outcome: compactionOutcome(session, freshContextResult, changed, now),
  });
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
  traceCommittedCompaction(plan, compactStartedAt, { messages, compacted, beforeEncoded, afterEncoded, changed });
  // Park a one-shot intent so the next turn's first send tags its cache
  // break instead of logging an unexplained input_prefix_mismatch.
  if (changed) {
    session.pendingCacheBreakIntent = mode === 'auto' ? 'post_turn_compaction' : 'manual_compaction';
  }
  return compactionResult(
    plan,
    { changed, reason: unchangedReason },
    { messages: compacted.length, tokens: afterTokens, messageTokens: afterMessageTokens },
    {
      freshContext: freshContextResult?.freshContext === true,
      freshContextError: null,
      handoffSource: freshContextResult?.handoffSource || 'session-local',
      usage: freshContextResult?.usage || null,
    }
  );
}

export async function runSessionCompaction(session, opts = {}) {
  if (!session || session.closed === true) return null;
  const plan = sessionCompactionPlan(session, opts);
  if (!plan) return null;
  if (!plan.force && plan.pressureTokens < plan.triggerTokens) {
    return compactionResult(plan, { changed: false, reason: 'below threshold' }, unchangedAfter(plan), {
      freshContext: false,
    });
  }
  const compactStartedAt = Date.now();
  try {
    await opts.onStageChange?.('compacting');
  } catch {
    /* best-effort */
  }
  const run = await runSessionHandoff(plan, opts);
  if (!run.compacted) return recordFailedCompaction(plan, run, compactStartedAt);
  return commitSessionCompaction(plan, run, compactStartedAt);
}
