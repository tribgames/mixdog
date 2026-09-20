// Pre-send auto-compact pass. Runs the proactive/reactive compaction decision
// + execution before each provider.send. Threaded via a state bag so the loop
// keeps its mutable counters (iterations reset on compaction, usage
// accumulation, the reactive-overflow flag, providerState invalidation).
import {
  resolveWorkerCompactPolicy,
  compactionTelemetryPressureTokens,
  currentContextEstimateTokens,
  compactTargetBudget,
  shouldCompactForSession,
  rememberCompactTelemetry,
  recordContextUsageSnapshot,
  emitCompactEvent,
  resolveHandoffSummaryModel,
} from './loop/compact-policy.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { estimateMessagesTokensSafe } from './loop/compact-debug.mjs';
import { messagesArrayChanged } from './loop/tool-helpers.mjs';
import { normalizeUsage, addUsage } from './loop/usage.mjs';
import { agentContextOverflowError } from './loop/context-overflow.mjs';
import { agentCompactFailedError } from './loop/context-overflow.mjs';
import { isContextOverflowError } from '../providers/retry-classifier.mjs';
import { traceAgentCompact, messagePrefixHash } from '../agent-trace.mjs';
import { invalidateProviderRequestToolsScope } from '../../../../session-runtime/provider-request-tools.mjs';
import { bumpUsageMetricsEpoch } from './manager.mjs';
import { resetReadStateAfterCompaction } from './read-dedup.mjs';
import {
  acknowledgePendingGoalReminder,
  markPendingGoalReminder,
  snapshotPendingGoalReminder,
} from '../../../../session-runtime/goal-reminder.mjs';

function writeStderr(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* best-effort */
  }
}

async function setStage(opts, stage) {
  try {
    await opts.onStageChange?.(stage);
  } catch {
    /* best-effort */
  }
}

// Best-effort JSON.stringify length — close enough to the payload we hand
// the provider for prefix-cache analysis.
function transcriptBytes(messages) {
  try {
    return Buffer.byteLength(JSON.stringify(messages), 'utf8');
  } catch {
    return null;
  }
}

function transcriptPrefixHash(messages) {
  try {
    return messagePrefixHash(messages);
  } catch {
    return null;
  }
}

// The compaction decision for this send. `pressureTokens` is the exact
// canonical value the decision uses; reactive overflow recovery floors it at
// the trigger so the gauge, telemetry, and forced compact still describe the
// same event. A pending reactive-overflow retry makes THIS compact pass the
// recovery from a provider overflow refusal, not the proactive pressure
// trigger — the emitted events are tagged so telemetry can tell them apart.
function preSendCompactDecision(state, compactPolicy) {
  const { messages, sessionRef } = state;
  const messageTokensEst = estimateMessagesTokensSafe(messages);
  const reactivePending = state.reactiveOverflowRetryPending === true;
  const pressureTokens = compactionTelemetryPressureTokens(messageTokensEst, compactPolicy, {
    reactivePending,
    messages,
    sessionRef,
  });
  const shouldCompact =
    state.skipProactiveCompact !== true &&
    shouldCompactForSession(messageTokensEst, compactPolicy, {
      forceReactive: reactivePending,
      messages,
      sessionRef,
      pressureTokens,
    });
  return {
    messageTokensEst,
    pressureTokens,
    shouldCompact,
    compactTrigger: reactivePending ? 'reactive' : 'auto',
    compactBudgetTokens: shouldCompact
      ? compactTargetBudget({ ...compactPolicy, pressureTokens }) || compactPolicy.boundaryTokens
      : compactPolicy.boundaryTokens,
  };
}

// Gauge sync (user: 컴팩트될 때 컨텍스트 표기량이 달랐다). The host refreshes
// its context readout on provider usage deltas and turn end, so a tool batch
// that pushed the transcript over the trigger fired compaction while the
// screen still showed headroom. Publish the decision's OWN numerator here —
// before compaction mutates the transcript — so the readout and the trigger
// describe one moment.
function publishContextPressure(opts, sessionId, compactPolicy, { pressureTokens, shouldCompact }) {
  if (typeof opts?.onContextPressure !== 'function') return;
  try {
    opts.onContextPressure({
      sessionId,
      usedTokens: pressureTokens,
      triggerTokens: compactPolicy.triggerTokens || compactPolicy.boundaryTokens || 0,
      boundaryTokens: compactPolicy.boundaryTokens || 0,
      willCompact: shouldCompact === true,
    });
  } catch {
    /* best-effort display hook */
  }
}

// Pre/PostCompact bridge to the standard hook bus: a session-property hook
// (manager/loop have no bus access), { trigger } normalized to
// 'auto'|'manual'. Best-effort — a hook must never break compaction or the
// loop.
async function runCompactHook(ctx, name) {
  const { opts, sessionRef, sessionId, cwd } = ctx.state;
  const hook = typeof opts[name] === 'function' ? opts[name] : sessionRef?.[name];
  if (typeof hook !== 'function') return;
  try {
    await hook({ sessionId, cwd, trigger: ctx.decision.compactTrigger === 'manual' ? 'manual' : 'auto' });
  } catch {
    /* best-effort */
  }
}

function compactTelemetry(ctx, stage, extra) {
  const { pressureTokens, messageTokensEst } = ctx.decision;
  rememberCompactTelemetry(ctx.state.sessionRef, ctx.compactPolicy, {
    stage,
    beforeTokens: pressureTokens,
    afterTokens: pressureTokens,
    messageTokensEst,
    pressureTokens,
    ...extra,
  });
}

function traceCompact(ctx, { compactChanged, afterBytes, durationMs, failure, details }) {
  const { state, compactPolicy, decision, before } = ctx;
  traceAgentCompact({
    sessionId: state.sessionId,
    iteration: ctx.iterations + 1,
    stage: 'pre_send',
    trigger: decision.compactTrigger,
    compact_changed: compactChanged,
    input_prefix_hash: before.prefixHash,
    before_count: before.count,
    after_count: state.messages.length,
    before_bytes: before.bytes,
    after_bytes: afterBytes,
    context_window: compactPolicy.contextWindow,
    budget_tokens: compactPolicy.boundaryTokens,
    boundary_tokens: compactPolicy.boundaryTokens,
    target_budget_tokens: decision.compactBudgetTokens,
    reserve_tokens: compactPolicy.reserveTokens,
    pressure_tokens: decision.pressureTokens,
    trigger_tokens: compactPolicy.triggerTokens,
    message_tokens_est: decision.messageTokensEst,
    duration_ms: durationMs,
    provider: state.sessionRef.provider,
    model: state.sessionRef.model || state.model,
    ...failure,
    details,
  });
}

function emitCompact(ctx, extra) {
  const { state, compactPolicy, decision, before } = ctx;
  emitCompactEvent(state.opts, {
    sessionId: state.sessionId,
    stage: 'pre_send',
    trigger: decision.compactTrigger,
    beforeTokens: decision.pressureTokens,
    beforeMessages: before.count,
    afterMessages: state.messages.length,
    pressureTokens: decision.pressureTokens,
    triggerTokens: compactPolicy.triggerTokens,
    boundaryTokens: compactPolicy.boundaryTokens,
    targetBudgetTokens: decision.compactBudgetTokens,
    reserveTokens: compactPolicy.reserveTokens,
    ...extra,
  });
}

function accumulateCompactUsage(ctx, usage) {
  const { sessionId, opts, loopUsageMetricsTurnId, loopUsageMetricsEpoch } = ctx.state;
  ctx.lastUsage = addUsage(ctx.lastUsage, usage);
  if (!ctx.firstTurnUsage) ctx.firstTurnUsage = normalizeUsage(usage);
  if (!sessionId || !opts.onUsageDelta) return;
  try {
    opts.onUsageDelta({
      sessionId,
      iterationIndex: ctx.iterations + 1,
      usageMetricsTurnId: loopUsageMetricsTurnId(),
      usageMetricsEpoch: loopUsageMetricsEpoch(),
      deltaInput: usage.inputTokens || 0,
      deltaOutput: usage.outputTokens || 0,
      deltaCachedRead: usage.cachedTokens || 0,
      deltaCacheWrite: usage.cacheWriteTokens || 0,
      source: 'fresh_context_compact',
      ts: Date.now(),
    });
  } catch {
    /* best-effort */
  }
}

// Runs the fresh-context compaction over the live transcript; the result
// (even a message-less one) is kept on `run` for the failure diagnostics.
async function compactTranscript(ctx, run) {
  const { state, compactPolicy, decision } = ctx;
  const { provider, messages, model, sessionRef, sessionId, signal, opts } = state;
  const { compactBudgetTokens } = decision;
  run.freshContextResult = await runFreshContextCompact({
    config: state.compactionConfig,
    sessionRef,
    messages,
    compactBudgetTokens,
    compactPolicy,
    sessionId,
    signal,
    provider,
    model: resolveHandoffSummaryModel(sessionRef, { budgetTokens: compactBudgetTokens }) || model,
    sendOpts: opts,
    goalReminderText: run.inlineGoalReminder?.content || '',
    activeTurn: true,
  });
  const freshMessages = Array.isArray(run.freshContextResult?.messages) ? run.freshContextResult.messages : null;
  if (!freshMessages) throw new Error('fresh-context compact produced no messages');
  run.compacted = freshMessages;
  if (run.freshContextResult.usage) accumulateCompactUsage(ctx, run.freshContextResult.usage);
}

function acknowledgeGoalReminder(sessionRef, run) {
  if (!run.inlineGoalReminder) return;
  try {
    acknowledgePendingGoalReminder(sessionRef, run.inlineGoalReminder.revision);
  } catch {
    /* best-effort: the reminder is either gone or already in the transcript */
  }
}

function isCompactAbort(signal, err) {
  return signal?.aborted === true || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'ABORT';
}

// A failed compact pass ends the send. A genuine cancellation/abort surfaced
// from the compact pipeline is NOT a context overflow: the fresh-context
// pipeline deliberately rethrows the original abort error unchanged so the
// session records a clean cancellation — and the manual/auto-clear runner
// (manager/compaction-runner.mjs) likewise never fabricates an
// AGENT_CONTEXT_OVERFLOW for an aborted compact. Mirror that here: preserve
// the real error (code/name/cause intact) instead of masking it as overflow.
// Detection is narrow on purpose — signal.aborted or a true AbortError — so
// the recall pipeline's SYNTHETIC "…aborted: memory … ; head preserved"
// failure (a real compact failure, message text aside) still escalates.
// Telemetry, trace and the failed compact event for one compact failure.
function reportCompactFailure(ctx, run, compactErr) {
  const { decision } = ctx;
  const compactFailMsg = compactErr?.message || String(compactErr);
  const freshFailMsg = run.freshContextError?.message || null;
  const compactFailCode =
    compactErr?.code ||
    (compactErr?.name === 'AgentContextOverflowError' ? 'AGENT_CONTEXT_OVERFLOW' : null) ||
    'compact_failed';
  compactTelemetry(ctx, 'overflow_failed', {
    trigger: decision.compactTrigger,
    freshContextError: freshFailMsg,
    compactError: freshFailMsg || compactFailMsg,
    durationMs: Date.now() - ctx.compactStartedAt,
  });
  traceCompact(ctx, {
    compactChanged: false,
    afterBytes: ctx.before.bytes,
    durationMs: Date.now() - ctx.compactStartedAt,
    failure: { error: compactFailMsg, error_code: compactFailCode },
    details: { freshContext: run.freshContextResult?.diagnostics || null, freshContextError: freshFailMsg },
  });
  emitCompact(ctx, {
    status: 'failed',
    afterTokens: decision.pressureTokens,
    messageTokensEst: decision.messageTokensEst,
    freshContext: true,
    durationMs: Date.now() - ctx.compactStartedAt,
    error: compactFailMsg,
  });
}

function throwCompactFailure(ctx, run, compactErr) {
  const { state, compactPolicy, decision } = ctx;
  const { sessionRef, sessionId, signal, model } = state;
  acknowledgeGoalReminder(sessionRef, run);
  if (isCompactAbort(signal, compactErr)) {
    writeStderr(
      `[loop] pre-send compact cancelled (sess=${sessionId || 'unknown'}): ${compactErr?.message || compactErr}\n`
    );
    throw compactErr;
  }
  reportCompactFailure(ctx, run, compactErr);
  // Only a GENUINE provider context-overflow surfaced from the compact
  // pipeline (e.g. the handoff-summary send itself overflowed the model
  // window) deserves AGENT_CONTEXT_OVERFLOW. Every other compact-stage
  // failure (dead memory runtime, Memory or handoff-summary failure) is a
  // compact failure, not "latest turn cannot fit" — mislabeling it as
  // overflow hides the real cause and misroutes downstream overflow
  // handling. Surface an explicit compact-failed error.
  const genuineOverflow =
    compactErr?.code === 'AGENT_CONTEXT_OVERFLOW' ||
    compactErr?.name === 'AgentContextOverflowError' ||
    isContextOverflowError(compactErr);
  if (genuineOverflow) {
    throw agentContextOverflowError(
      {
        stage: 'pre_send',
        sessionId,
        sessionRef,
        model,
        budgetTokens: decision.compactBudgetTokens,
        reserveTokens: compactPolicy.reserveTokens,
        messageTokensEst: decision.messageTokensEst,
      },
      compactErr
    );
  }
  throw agentCompactFailedError({ stage: 'pre_send', sessionId, sessionRef, model }, compactErr);
}

// Replaces the live transcript with the compacted one and resets everything
// keyed to the old transcript shape.
function adoptCompactedTranscript(ctx, run) {
  const { messages, sessionRef, sessionId, opts } = ctx.state;
  messages.length = 0;
  messages.push(...run.compacted);
  acknowledgeGoalReminder(sessionRef, run);
  resetReadStateAfterCompaction(sessionId);
  // This attempt's provider-tool scope was keyed to the old transcript
  // shape. Invalidate it synchronously before any post-compact callback or
  // subsequent async continuation.
  invalidateProviderRequestToolsScope();
  // The next provider send intentionally starts a new transcript shape.
  // Keep this one-shot observability tag separate from an unexplained
  // prefix mismatch.
  opts.cacheBreakIntent = 'automatic_compaction';
  // Compacting/pruning the transcript invalidates the server-side
  // conversation anchor (xAI Responses / openai-oauth WS rely on
  // previous_response_id which points at a now-mutated prefix). Drop
  // providerState so the next send starts a fresh chain.
  ctx.providerState = undefined;
  ctx.providerStateCleared = true;
  // Compaction shrank the transcript, so prior turns no longer pressure the
  // window — reset the iteration counter so a steadily-compacting long task
  // isn't killed by the cap, while a non-compacting tight loop still hits it.
  ctx.iterations = 0;
  // New loop epoch so persistIterationMetrics idempotency keys do not
  // collide when iteration indices restart at 1 (incl. iter 1 → iter 1).
  if (sessionRef) bumpUsageMetricsEpoch(sessionRef);
}

function reportCompactOutcome(ctx, run) {
  const { state, compactPolicy } = ctx;
  const { messages, sessionRef } = state;
  const changed = ctx.compactChanged || run.summaryChanged;
  const { freshContextResult } = run;
  const afterMessageTokensEst = estimateMessagesTokensSafe(messages);
  // Same scale as the pre-compact gauge: compaction invalidated the provider
  // baseline, so the post-compact gauge number is the calibrated transcript
  // estimate plus the request reserve.
  const afterTokens = currentContextEstimateTokens(afterMessageTokensEst, compactPolicy);
  const durationMs = Date.now() - ctx.compactStartedAt;
  compactTelemetry(ctx, 'pre_send', {
    afterTokens,
    compactChanged: changed,
    freshContext: freshContextResult?.freshContext === true,
    freshContextError: run.freshContextError?.message || null,
    handoffSource: freshContextResult?.handoffSource || null,
    compactError: null,
    durationMs,
  });
  if (changed) {
    recordContextUsageSnapshot(sessionRef, compactPolicy, {
      messages,
      usedTokens: afterTokens,
      messageTokensEst: afterMessageTokensEst,
      source: 'post_compact',
    });
  }
  traceCompact(ctx, {
    compactChanged: changed,
    afterBytes: transcriptBytes(messages),
    durationMs,
    details: { freshContext: freshContextResult?.diagnostics || null },
  });
  emitCompact(ctx, {
    status: changed ? 'compacted' : 'no_change',
    afterTokens,
    changed,
    freshContext: freshContextResult?.freshContext === true,
    handoffSource: freshContextResult?.handoffSource || null,
    durationMs,
  });
}

async function compactBeforeSend(ctx) {
  const { state, decision } = ctx;
  const { messages, sessionRef, sessionId, opts } = state;
  // Snapshot BEFORE mutating the live array below, so compact_meta reports
  // real savings and the true input prefix rather than the replacement
  // transcript.
  ctx.before = { count: messages.length, bytes: transcriptBytes(messages), prefixHash: transcriptPrefixHash(messages) };
  await setStage(opts, 'compacting');
  ctx.compactStartedAt = Date.now();
  // Clear the one-shot reactive-overflow flag now that this compact pass is
  // consuming it (the decision's trigger already captured it).
  ctx.reactiveOverflowRetryPending = false;
  await runCompactHook(ctx, 'preCompactHook');
  compactTelemetry(ctx, 'compacting', { trigger: decision.compactTrigger });
  const run = {
    compacted: null,
    summaryChanged: false,
    freshContextResult: null,
    freshContextError: null,
    inlineGoalReminder: null,
  };
  try {
    try {
      markPendingGoalReminder(sessionRef, 'compaction');
      run.inlineGoalReminder = snapshotPendingGoalReminder(sessionRef);
    } catch {
      run.inlineGoalReminder = null;
    }
    try {
      await compactTranscript(ctx, run);
    } catch (freshErr) {
      run.freshContextError = freshErr;
      writeStderr(
        `[loop] fresh-context compact failed (sess=${sessionId || 'unknown'}): ${freshErr?.message || freshErr}\n`
      );
      throw freshErr;
    }
    run.summaryChanged = messagesArrayChanged(messages, run.compacted);
  } catch (compactErr) {
    throwCompactFailure(ctx, run, compactErr);
  }
  await setStage(opts, 'requesting');
  ctx.compactChanged = messagesArrayChanged(messages, run.compacted);
  if (ctx.compactChanged) adoptCompactedTranscript(ctx, run);
  reportCompactOutcome(ctx, run);
  // PostCompact belongs only to a completed compaction pass, never the
  // ordinary pre-send threshold check.
  await runCompactHook(ctx, 'postCompactHook');
}

export async function runPreSendCompactPass(state) {
  const ctx = {
    state,
    iterations: state.iterations,
    lastUsage: state.lastUsage,
    firstTurnUsage: state.firstTurnUsage,
    providerState: state.providerState,
    reactiveOverflowRetryPending: state.reactiveOverflowRetryPending,
    providerStateCleared: false,
    compactChanged: false,
  };
  const compactPolicy = resolveWorkerCompactPolicy(state.sessionRef, state.requestTools);
  if (compactPolicy?.auto) {
    ctx.compactPolicy = compactPolicy;
    ctx.decision = preSendCompactDecision(state, compactPolicy);
    publishContextPressure(state.opts, state.sessionId, compactPolicy, ctx.decision);
    if (ctx.decision.shouldCompact) await compactBeforeSend(ctx);
    else compactTelemetry(ctx, 'pre_send_check');
  }
  return {
    iterations: ctx.iterations,
    lastUsage: ctx.lastUsage,
    firstTurnUsage: ctx.firstTurnUsage,
    providerState: ctx.providerState,
    providerStateCleared: ctx.providerStateCleared,
    reactiveOverflowRetryPending: ctx.reactiveOverflowRetryPending,
    compactChanged: ctx.compactChanged,
  };
}
