// Session compaction runner — one fresh-context Compact contract.
// Self-contained: operates on a live `session` object + opts, using pure
// compact/context helpers. No runtime-liveness (_runtimeState) coupling —
// manager.mjs still owns scheduling / stage gating and simply calls
// runSessionCompaction().
import { getProvider } from '../../providers/registry.mjs';
import { HANDOFF_TIMEOUT_MAX_MS } from '../compact/constants.mjs';
import { jsonByteLength } from '../compact/json-byte-length.mjs';
import {
  estimateMessagesTokens,
  estimateRequestReserveTokens,
  estimateTranscriptContextUsage,
  primeContextEstimates,
  resolveCompactBufferRatio,
} from '../context-utils.mjs';
import { runFreshContextCompact } from '../loop/fresh-context.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
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
  resolveHandoffSummaryModel,
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
async function sessionCompactionPlan(session, opts) {
  const resolvedSessionId = opts.sessionId || session.id || null;
  const mode = opts.mode === 'auto' ? 'auto' : 'manual';
  const force = opts.force === true || mode === 'manual';
  if (mode === 'auto' && session.compaction?.auto === false) return null;
  // Every stage prices and compacts this snapshot. The live array keeps
  // receiving turns meanwhile (nothing serializes an ask against a running
  // compaction), and commitSessionCompaction reconciles it with the result.
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
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
  // A cold (just loaded) transcript is metered in slices first; the plan
  // numbers below then read the per-message memos.
  await primeContextEstimates(messages, session);
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

const ENCODE_SLICE_MS = 20;

// JSON.stringify(list) is exactly '[' + each element's own encoding ('null'
// when that is undefined) joined by ',' + ']', and that concatenation parses
// back unambiguously. So byte length is additive over elements and two lists
// encode equal iff they have the same length and equal element encodings; a
// shared element object encodes the same on both sides. Compare the pre- and
// post-compaction transcripts element by element, yielding between slices,
// instead of building two whole-transcript strings in one block. A null byte
// count means that list does not encode (JSON.stringify throws).
// toJSON(key) sees the element index only inside the array, so a list with a
// toJSON element is encoded whole.
async function compareTranscriptEncodings(before, after) {
  const hasToJson = (list) => list.some((m) => typeof m?.toJSON === 'function');
  if (hasToJson(before) || hasToJson(after)) {
    const whole = (list) => {
      try {
        return JSON.stringify(list);
      } catch {
        return null;
      }
    };
    const beforeEncoded = whole(before);
    const afterEncoded = whole(after);
    return {
      beforeBytes: beforeEncoded === null ? null : Buffer.byteLength(beforeEncoded, 'utf8'),
      afterBytes: afterEncoded === null ? null : Buffer.byteLength(afterEncoded, 'utf8'),
      differ: beforeEncoded !== afterEncoded,
    };
  }
  // Encodings are built only to compare an unshared pair while the lists
  // could still encode equal; every other element is only measured.
  const encode = (value) => {
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      return null;
    }
  };
  const measure = (value, index) => {
    try {
      return jsonByteLength(value, index) ?? 4;
    } catch {
      return null;
    }
  };
  const encodedBytes = (json) => (json === null ? null : Buffer.byteLength(json, 'utf8'));
  // Brackets plus one comma between elements.
  const side = (list) => ({ bytes: list.length ? 1 + list.length : 2, ok: true });
  const add = (target, bytes) => {
    if (bytes === null) target.ok = false;
    else target.bytes += bytes;
  };
  const beforeSide = side(before);
  const afterSide = side(after);
  let differ = before.length !== after.length;
  let sliceStart = performance.now();
  const count = Math.max(before.length, after.length);
  for (let index = 0; index < count && (beforeSide.ok || afterSide.ok); index += 1) {
    const inBefore = index < before.length;
    const inAfter = index < after.length;
    const shared = inBefore && inAfter && before[index] === after[index];
    let beforeBytes = null;
    let afterBytes = null;
    if (!differ && !shared) {
      const beforeJson = encode(before[index]);
      const afterJson = encode(after[index]);
      beforeBytes = encodedBytes(beforeJson);
      afterBytes = encodedBytes(afterJson);
      if (beforeJson !== afterJson) differ = true;
    } else {
      if (inBefore && (beforeSide.ok || shared)) beforeBytes = measure(before[index], index);
      if (shared) afterBytes = beforeBytes;
      else if (inAfter && afterSide.ok) afterBytes = measure(after[index], index);
    }
    if (inBefore && beforeSide.ok) add(beforeSide, beforeBytes);
    if (inAfter && afterSide.ok) add(afterSide, afterBytes);
    if (performance.now() - sliceStart >= ENCODE_SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  }
  return {
    beforeBytes: beforeSide.ok ? beforeSide.bytes : null,
    afterBytes: afterSide.ok ? afterSide.bytes : null,
    differ,
  };
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
  { messages, compacted, beforeBytes, afterBytes, changed }
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
      before_bytes: beforeBytes,
      after_bytes: afterBytes,
    },
  });
}

// The post-compaction numbers and whether the transcript actually changed.
// afterTokens is on the same scale as beforeTokens: compaction invalidates
// the provider baseline, so the gauge's post-compact number is the
// calibrated transcript estimate plus the request reserve. The raw sum
// reported roughly half of that.
function afterTranscriptTokens(plan, transcript, afterMessageTokens) {
  const postCompactPolicy = resolveSessionCompactionPolicy(plan.session, transcript) || plan.alignedPolicy;
  const afterTokens = postCompactPolicy
    ? currentContextEstimateTokens(afterMessageTokens, postCompactPolicy)
    : afterMessageTokens + plan.reserveTokens;
  return { postCompactPolicy, afterTokens };
}

async function afterCompactionNumbers(plan, compacted) {
  const { messages } = plan;
  const { beforeBytes, afterBytes, differ } = await compareTranscriptEncodings(messages, compacted);
  const afterMessageTokens = estimateMessagesTokens(compacted);
  const changed =
    beforeBytes !== null && afterBytes !== null
      ? differ
      : compacted.length !== messages.length || afterMessageTokens !== plan.beforeMessageTokens;
  return {
    beforeBytes,
    afterBytes,
    afterMessageTokens,
    ...afterTranscriptTokens(plan, compacted, afterMessageTokens),
    changed,
    transcript: compacted,
  };
}

// The messages appended to the live transcript since the plan snapshot, in
// order ([] when none), or null when it no longer starts with every snapshot
// message (rewound, cleared, replaced or edited): the compacted result then
// cannot be reconciled with it.
function appendedSinceSnapshot(plan) {
  const live = plan.session.messages;
  const snapshot = plan.messages;
  if (!Array.isArray(live) || live.length < snapshot.length) return null;
  for (let index = 0; index < snapshot.length; index += 1) {
    if (live[index] !== snapshot[index]) return null;
  }
  return live.slice(snapshot.length);
}

// Numbers for the compacted result followed by the messages a finished turn
// appended meanwhile. The token estimate is a per-message sum and the JSON
// byte length of a concatenation is the sum less one pair of brackets plus a
// separating comma, so only the appended messages are priced again.
function withAppendedMessages(plan, numbers, appended) {
  const transcript = [...numbers.transcript, ...appended];
  const afterMessageTokens = numbers.afterMessageTokens + estimateMessagesTokens(appended);
  let afterBytes = null;
  if (numbers.afterBytes !== null) {
    try {
      const appendedBytes = Buffer.byteLength(JSON.stringify(appended), 'utf8');
      afterBytes = numbers.afterBytes + appendedBytes - 2 + (numbers.transcript.length ? 1 : 0);
    } catch {
      afterBytes = null;
    }
  }
  return {
    ...numbers,
    afterBytes,
    afterMessageTokens,
    ...afterTranscriptTokens(plan, transcript, afterMessageTokens),
    transcript,
  };
}

const TRANSCRIPT_MOVED_ERROR =
  'compact: the conversation changed while compacting; compaction not applied, run it again';

async function commitSessionCompaction(plan, run, compactStartedAt) {
  const { session, messages, mode, force, resolvedSessionId, reserveTokens } = plan;
  const { freshContextResult } = run;
  const numbers = await afterCompactionNumbers(plan, run.compacted);
  // Reconcile with the live transcript synchronously up to the replacement
  // below: a turn in flight owns it and would overwrite the result, and a
  // transcript that no longer extends the snapshot cannot take it. Both
  // leave the conversation exactly as it is now. Messages a finished turn
  // appended are kept, in order, after the compacted result.
  const appended = isSessionCompactionBlocked(resolvedSessionId) ? null : appendedSinceSnapshot(plan);
  if (!appended) {
    return recordFailedCompaction(
      plan,
      { compactError: new Error(TRANSCRIPT_MOVED_ERROR), freshContextError: null },
      compactStartedAt
    );
  }
  const { beforeBytes, afterBytes, afterMessageTokens, postCompactPolicy, afterTokens, changed, transcript } =
    appended.length ? withAppendedMessages(plan, numbers, appended) : numbers;
  let unchangedReason = null;
  if (!changed) unchangedReason = force ? 'nothing to compact' : 'below threshold';
  const now = Date.now();
  session.messages = transcript;
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
        messages: transcript,
        usedTokens: afterTokens,
        messageTokensEst: afterMessageTokens,
        source: 'post_compact',
        updatedAt: now,
      });
    }
  }
  traceCommittedCompaction(plan, compactStartedAt, {
    messages,
    compacted: transcript,
    beforeBytes,
    afterBytes,
    changed,
  });
  // Park a one-shot intent so the next turn's first send tags its cache
  // break instead of logging an unexplained input_prefix_mismatch.
  if (changed) {
    session.pendingCacheBreakIntent = mode === 'auto' ? 'post_turn_compaction' : 'manual_compaction';
  }
  return compactionResult(
    plan,
    { changed, reason: unchangedReason },
    { messages: transcript.length, tokens: afterTokens, messageTokens: afterMessageTokens },
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
  const plan = await sessionCompactionPlan(session, opts);
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
  // Keep the plan's whole-transcript pricing and the handoff pass in separate
  // event-loop turns.
  await new Promise((resolve) => setImmediate(resolve));
  const run = await runSessionHandoff(plan, opts);
  if (!run.compacted) return recordFailedCompaction(plan, run, compactStartedAt);
  return commitSessionCompaction(plan, run, compactStartedAt);
}
