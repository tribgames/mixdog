/**
 * send-phase.mjs — one provider round of the agent loop: open the iteration
 * (steering drain, request boundary, eager dispatcher), send with recovery,
 * consume a retry verdict, and settle a completed send into the loop state.
 */
import { traceCacheBreak } from '../../cache-break-trace.mjs';
import { resolveLiveToolCwd } from './tool-exec.mjs';
import { prepareExplicitSkills } from '../explicit-skills.mjs';
import { addUsage, usageDeltaEvent } from './usage.mjs';
import { prepareProviderRequest } from './request-boundary.mjs';
import { projectProviderRequest } from './request-projection.mjs';
import { traceProviderSend, traceOutputTruncation } from './diagnostics.mjs';
import { createEagerDispatcher } from '../eager-dispatch.mjs';
import { sendWithRecovery } from '../send-with-recovery.mjs';
import { stripInlineImages } from '../image-strip-recovery.mjs';
import { _buildRouteRoundReminder } from '../manager/rules-cache.mjs';
import { runWithProviderRequestToolsScope } from '../../../../../session-runtime/provider-request-tools.mjs';
import { REPEAT_FAIL_LIMIT } from './loop-state.mjs';

/**
 * Open an iteration: refresh the live cwd, drain queued steering after a
 * tool batch, resolve explicit skill prompts, compute the request boundary
 * and arm the eager dispatcher. Returns the round record the send and tool
 * phases share.
 */
export async function beginIteration(state) {
  const { opts, sessionRef, provider, model, messages, tools, sessionId, signal } = state;
  // A cwd tool call updates sessionRef in place. Refresh before building this
  // iteration's eager dispatcher and cache keys so every following tool
  // family, including apply_patch, observes the new write root.
  state.cwd = resolveLiveToolCwd(state.cwd, sessionRef);
  const iterT0 = Date.now();
  state.throwIfAborted();
  // Drain queued steering/prompts BEFORE the pre-send compact check, but only
  // immediately after a tool batch has completed: queued entries are attached
  // after tool results and before the continuation, not on arbitrary
  // non-tool continuations (empty nudges, provider pauses, etc.).
  if (state.toolBatchJustCompleted) {
    state.drainSteering('pre-send', { maxPriority: state.lastToolBatchHadSleep ? 'later' : 'next' });
    state.toolBatchJustCompleted = false;
    state.lastToolBatchHadSleep = false;
  }
  // Drains are synchronous (also used by terminal guards). Perform the
  // policy-checked selection before the next provider snapshot instead of
  // starting detached work from a drain callback.
  while (state.pendingSkillPrompts.length) {
    await prepareExplicitSkills(state.pendingSkillPrompts.shift(), messages, sessionRef, {
      cwd: state.cwd,
      signal: opts.signal,
    });
  }
  const boundary = await prepareProviderRequest({
    provider,
    messages,
    model,
    baseSendTools: tools,
    sessionRef,
    sessionId,
    cwd: state.cwd,
    opts,
    signal,
    iterations: state.iterations,
    lastUsage: state.lastUsage,
    firstTurnUsage: state.firstTurnUsage,
    providerState: state.providerState,
    reactiveOverflowRetryPending: state.reactiveOverflowRetryPending,
    fixedProviderToolSurface: state.fixedProviderToolSurface,
    loopUsageMetricsTurnId: state.usageMetricsTurnId,
    loopUsageMetricsEpoch: state.usageMetricsEpoch,
  });
  state.iterations = boundary.iterations;
  state.lastUsage = boundary.lastUsage;
  state.firstTurnUsage = boundary.firstTurnUsage;
  state.providerState = boundary.providerState;
  state.reactiveOverflowRetryPending = boundary.reactiveOverflowRetryPending;
  state.fixedProviderToolSurface = boundary.fixedProviderToolSurface;
  if (boundary.providerStateCleared) state.providerStateUpdated = true;
  const nextIteration = state.iterations + 1;
  opts.iteration = nextIteration;
  opts.providerState = state.providerState;
  // The route policy's per-round batching reminder (rules/routes/*.md,
  // `round-reminder:`). One reminder per round: a provider that delivers one
  // itself declares `deliversRoundReminder` and the runtime channel stays
  // silent; otherwise the tool batch appends it as a <system-reminder>.
  opts.roundReminder =
    _buildRouteRoundReminder({ provider: sessionRef?.provider || provider?.name || null, model }) || null;
  opts.roundReminderByProvider = provider?.constructor?.deliversRoundReminder === true;
  if (state.forcedFirstTool && state.toolCallsTotal === 0) {
    opts.toolChoice = 'required';
  } else {
    delete opts.toolChoice;
  }
  // The adapter must serialize this exact immutable list. Direct adapter
  // callers omit the flag and retain legacy live deferred resolution.
  opts.providerToolSnapshotAuthoritative = true;
  opts.providerNativeToolPrefixCount = boundary.requestToolScope.nativePrefixCount;
  state.lastSendTools = boundary.sendTools;
  // Eager-dispatch queue (see ../eager-dispatch.mjs): read-only tools start
  // the instant the provider streams a tool-call event; writes and unknown
  // tools wait until send() returns. The dispatcher owns pending, the
  // intra-turn sig set, and the mutation epoch, all fresh per turn.
  const eager = createEagerDispatcher({
    tools,
    cwd: state.cwd,
    sessionId,
    sessionRef,
    signal,
    opts,
    crossTurnCalls: state.crossTurnCalls,
    getIterations: () => state.iterations,
    getNextIteration: () => nextIteration,
    repeatFailLimit: REPEAT_FAIL_LIMIT,
  });
  opts.onToolCall = (call) => {
    try {
      opts.onAssistantToolCallObserved?.(call, { eagerStarted: false });
    } catch {}
    return eager.onToolCall(call);
  };
  return { iterT0, nextIteration, sendTools: boundary.sendTools, requestToolScope: boundary.requestToolScope, eager };
}

/** Project the transcript for the provider and send it with recovery. */
export async function sendProviderRequest(state, round) {
  const { opts, provider, model, messages, sessionRef, sessionId } = state;
  const sendStartedAt = Date.now();
  const preSendMs = sendStartedAt - round.iterT0;
  const toolResumeMs = state.lastToolBatchEndedAt ? sendStartedAt - state.lastToolBatchEndedAt : null;
  if (state.imageStripActive && !state.sendMessages) {
    state.sendMessages = stripInlineImages(messages).messages;
  }
  const messageSource = state.sendMessages || messages;
  const { providerMessages, prefixGuardCandidate } = projectProviderRequest({
    messages: messageSource,
    sendTools: round.sendTools,
    opts,
    provider,
    sessionRef,
    sessionId,
    model,
    iteration: round.nextIteration,
    prefixGuardState: state.prefixGuardState,
    cacheBreakTraceKeys: state.cacheBreakTraceKeys,
  });
  try {
    opts.onProviderSendStarted?.();
  } catch {}
  const result = await runWithProviderRequestToolsScope(round.requestToolScope, () =>
    sendWithRecovery({
      provider,
      messages: providerMessages,
      recoveryMessages: messageSource,
      model,
      sendTools: round.sendTools,
      tools: round.sendTools,
      opts,
      sessionId,
      sessionRef,
      nextIteration: round.nextIteration,
      contextOverflowRetryUsed: state.contextOverflowRetryUsed,
      transportRetriesUsed: state.transportRetriesUsed,
      transportRetryMax: state.transportRetryMax,
      imageStripUsed: state.imageStripUsed,
      thinkingReplayRepairUsed: state.thinkingReplayRepairUsed,
      signal: state.signal,
    })
  );
  return {
    result,
    providerMessages,
    prefixGuardCandidate,
    sendStartedAt,
    sendEndedAt: Date.now(),
    preSendMs,
    toolResumeMs,
  };
}

/** Consume a recovery verdict; true when the loop must start the next round
 *  instead of processing a response. */
export function applyRetryAction(state, result) {
  switch (result.action) {
    case 'retry':
      // Keep opts.cacheBreakIntent: the failed send never consumed the tag,
      // and the reactive-compact retry that follows IS the tagged transition.
      state.contextOverflowRetryUsed = true;
      state.reactiveOverflowRetryPending = true;
      return true;
    case 'retry_transport':
      state.transportRetriesUsed += 1;
      state.transportRetryMax = Number(result.transportRetryMax) || 0;
      return true;
    case 'retry_replay_repair':
      // The offending turn was repaired in the live transcript, so the replay
      // is rebuilt from repaired history and the session keeps the fix. No
      // transport budget is consumed: nothing was generated.
      state.thinkingReplayRepairUsed = true;
      return true;
    case 'retry_image_strip':
      state.transportRetriesUsed += 1;
      state.imageStripUsed = true;
      state.imageStripActive = true;
      state.pendingImageStripPersistMessages = Array.isArray(result.persistMessages) ? result.persistMessages : null;
      if (Array.isArray(result.messages)) state.sendMessages = result.messages;
      return true;
    default:
      return false;
  }
}

/** Fold a completed send into the state: prefix guard, image-strip
 *  rebaseline, per-request budgets, provider state, usage and diagnostics. */
export function settleSendResult(state, round, sent) {
  const { opts, sessionRef, sessionId, provider, model, messages } = state;
  const response = sent.result.response;
  state.response = response;
  state.prefixGuardState = sent.prefixGuardCandidate;
  if (sessionRef) sessionRef._providerPrefixGuardState = state.prefixGuardState;
  if (state.imageStripActive) {
    if (Array.isArray(state.pendingImageStripPersistMessages)) {
      messages.splice(0, messages.length, ...state.pendingImageStripPersistMessages);
    } else {
      state.prefixGuardState = null;
      if (sessionRef) delete sessionRef._providerPrefixGuardState;
      traceCacheBreak({
        sessionId,
        iteration: round.nextIteration,
        classification: 'intentional',
        reason: 'image_strip_nonpersistent_rebaseline',
        source: 'image_strip_retry',
        provider: sessionRef?.provider || provider?.name || null,
        model: model || null,
        previousCount: sent.providerMessages.length,
        nextCount: messages.length,
      });
    }
    state.imageStripActive = false;
    state.pendingImageStripPersistMessages = null;
  }
  opts.onToolCall = undefined;
  delete opts.cacheBreakIntent;
  state.contextOverflowRetryUsed = false;
  // A completed send ends the outage this budget was covering; the next
  // iteration is a fresh request and must get the full replay budget again.
  state.transportRetriesUsed = 0;
  state.transportRetryMax = 0;
  delete opts._stallRetryBudget;
  state.imageStripUsed = false;
  state.sendMessages = null;
  // Capture opaque state for the next turn only when the provider explicitly
  // returned the field. Absence means "no update"; an own property with
  // null/undefined means "clear".
  if (response && Object.hasOwn(response, 'providerState')) {
    state.providerState = response.providerState;
    state.providerStateUpdated = true;
  }
  state.iterations = round.nextIteration;
  traceProviderSend({
    sessionId,
    iteration: state.iterations,
    sendMs: Date.now() - sent.sendStartedAt,
    preSendMs: sent.preSendMs,
    toolResumeMs: sent.toolResumeMs,
    messages,
    providerMessages: sent.providerMessages,
    model,
    sendTools: round.sendTools,
    sessionAgent: state.sessionAgent,
  });
  // Accumulate usage across iterations — every billable slot, not just
  // input/output: cache_read/cache_write surge on later iterations (warm
  // prefix reuse), so aggregating only the head would drop most cache tokens.
  if (response.usage) {
    const hadUsage = !!state.lastUsage;
    state.lastUsage = addUsage(state.lastUsage, response.usage);
    // Snapshot the first turn separately so callers can show iter1 vs final
    // cache-hit ratios.
    if (!hadUsage) state.firstTurnUsage = { ...state.lastUsage };
  }
  // Provider may have returned despite an abort (SDKs that don't honour
  // signal) — bail before processing any of its output.
  state.throwIfAborted();
  traceOutputTruncation({ sessionId, iteration: state.iterations, response, sessionAgent: state.sessionAgent });
  if (sessionId && opts.onUsageDelta && response.usage) {
    try {
      runWithProviderRequestToolsScope(round.requestToolScope, () =>
        opts.onUsageDelta(
          usageDeltaEvent({
            sessionId,
            iterationIndex: state.iterations,
            usageMetricsTurnId: state.usageMetricsTurnId(),
            usageMetricsEpoch: state.usageMetricsEpoch(),
            requestedModel: model,
            model: response.model || model,
            usage: response.usage,
            sendTools: round.sendTools,
          })
        )
      );
    } catch {
      /* best-effort — never break the loop */
    }
  }
}
