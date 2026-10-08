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
import { runWithProviderRequestToolsScope } from '../../runtime-core/provider-request-tools.mjs';
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
    crossTurnCalls: state.crossTurnCalls,
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
  // Every attempt is built from the live transcript, so a compaction between
  // attempts reaches the provider; a pending image strip only filters it.
  const messageSource = state.imageStrip
    ? stripInlineImages(messages, { ids: state.imageStrip.ids }).messages
    : messages;
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

// A replay may carry a runtime notice for the model (e.g. split an oversized
// tool call). It joins the transcript the next send is built from once: a
// repeated cut keeps the single notice already at the tail.
function appendRecoveryNotice(state, notice) {
  const { messages } = state;
  if (messages[messages.length - 1]?.meta?.source === notice.meta?.source) return;
  messages.push({ ...notice, meta: { ...notice.meta } });
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
      if (result.notice) appendRecoveryNotice(state, result.notice);
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
      state.imageStrip = { ids: new Set(result.imageIds), persist: result.persist === true };
      return true;
    default:
      return false;
  }
}

// An image-strip retry succeeded: heal the stripped images out of the live
// transcript when the recovery asked for it, otherwise drop the prefix guard
// so the next send rebaselines against the unstripped history.
function settleImageStrip(state, round, sent) {
  const { sessionRef, sessionId, provider, model, messages, imageStrip } = state;
  if (imageStrip.persist) {
    messages.splice(0, messages.length, ...stripInlineImages(messages, { ids: imageStrip.ids }).messages);
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
  state.imageStrip = null;
}

const MESSAGES_CACHE_TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 };
const MISS_RATIO = 0.5;
const MISS_MIN_DROP_TOKENS = 4096;

/** Usage-based prompt-cache miss detection for Anthropic sessions. The
 *  baseline (previous request's cache read + write) lives on the session
 *  record so it survives a reload, unlike the in-memory prefix guard. */
function traceActualCacheMiss(state, sent, response, { previousGuardState, previousSendAt, cacheBreakIntent }) {
  const { sessionRef, sessionId, model } = state;
  const providerName = sessionRef?.provider || state.provider?.name || null;
  if (!sessionRef || (providerName !== 'anthropic' && providerName !== 'anthropic-oauth')) return;
  const usage = response?.usage || {};
  const cachedTokens = Number(usage.cachedTokens) || 0;
  const cachePrefixTokens = cachedTokens + (Number(usage.cacheWriteTokens) || 0);
  const baseline = Number(sessionRef.lastProviderCachedPrefixTokens);
  const ttlMs = MESSAGES_CACHE_TTL_MS[sessionRef.providerCacheOpts?.cacheStrategy?.messages];
  const idleMs = sent.sendStartedAt - previousSendAt;
  const requestPrefixChanged =
    !!previousGuardState &&
    previousGuardState.requestPrefixHash !== sent.prefixGuardCandidate?.requestPrefixHash;
  if (
    baseline > 0 &&
    ttlMs &&
    Number.isFinite(idleMs) &&
    idleMs >= 0 &&
    idleMs < ttlMs &&
    cachedTokens < baseline * MISS_RATIO &&
    baseline - cachedTokens >= MISS_MIN_DROP_TOKENS &&
    !cacheBreakIntent &&
    !requestPrefixChanged
  ) {
    traceCacheBreak(
      {
        sessionId,
        iteration: state.iterations + 1,
        classification: 'unexpected',
        reason: 'actual_cache_miss',
        source: 'provider_usage',
        provider: providerName,
        model: model || null,
        actualCacheMiss: true,
        cachedTokens,
        promptTokens: Number(usage.promptTokens) || null,
        previousCachedPrefixTokens: baseline,
        idleMs,
        missingPrefixGuardBaseline: !previousGuardState,
      },
      state.cacheBreakTraceOptions
    );
  }
  sessionRef.lastProviderCachedPrefixTokens = cachePrefixTokens;
}

/** Fold a completed send into the state: prefix guard, image-strip
 *  rebaseline, per-request budgets, provider state, usage and diagnostics. */
export function settleSendResult(state, round, sent) {
  const { opts, sessionRef, sessionId, model, messages } = state;
  const response = sent.result.response;
  state.response = response;
  const previousGuardState = state.prefixGuardState;
  const previousSendAt = Number(sessionRef?.lastProviderSendAt);
  const cacheBreakIntent = opts.cacheBreakIntent;
  state.prefixGuardState = sent.prefixGuardCandidate;
  if (sessionRef) sessionRef._providerPrefixGuardState = state.prefixGuardState;
  // The provider read and refreshed its prompt cache when this request was
  // sent; agent cache-expiry compaction measures idle time from here.
  if (sessionRef) sessionRef.lastProviderSendAt = sent.sendStartedAt;
  traceActualCacheMiss(state, sent, response, {
    previousGuardState,
    previousSendAt,
    cacheBreakIntent,
  });
  if (state.imageStrip) settleImageStrip(state, round, sent);
  opts.onToolCall = undefined;
  delete opts.cacheBreakIntent;
  state.contextOverflowRetryUsed = false;
  // A completed send ends the outage this budget was covering; the next
  // iteration is a fresh request and must get the full replay budget again.
  state.transportRetriesUsed = 0;
  state.transportRetryMax = 0;
  delete opts._stallRetryBudget;
  state.imageStripUsed = false;
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
  // A response without usage is still an unmeasured call. Do not silently
  // omit it and later label a mixed reasoning subtotal as complete.
  const reportedUsage = response.usage || {};
  const hadUsage = !!state.lastUsage;
  state.lastUsage = addUsage(state.lastUsage, reportedUsage);
  // Snapshot the first turn separately so callers can show iter1 vs final
  // cache-hit ratios.
  if (!hadUsage) state.firstTurnUsage = { ...state.lastUsage };
  // Provider may have returned despite an abort (SDKs that don't honour
  // signal) — bail before processing any of its output.
  state.throwIfAborted();
  traceOutputTruncation({ sessionId, iteration: state.iterations, response, sessionAgent: state.sessionAgent });
  if (sessionId && opts.onUsageDelta) {
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
            usage: reportedUsage,
            sendTools: round.sendTools,
          })
        )
      );
    } catch {
      /* best-effort — never break the loop */
    }
  }
}
