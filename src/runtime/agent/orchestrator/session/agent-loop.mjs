import { isAgentOwner } from '../agent-owner.mjs';
import { SessionClosedError } from './manager.mjs';
import { recordToolBatch } from '../tools/tool-batch-trace.mjs';
import { traceCacheBreak } from '../cache-break-trace.mjs';

import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import { resolveLiveToolCwd } from './loop/tool-exec.mjs';
import { createSteeringDrain } from './loop/steering.mjs';
import { prepareExplicitSkills } from './explicit-skills.mjs';
import { addUsage, usageDeltaEvent } from './loop/usage.mjs';
import {
  normalizeHookUpdatedToolOutput,
  resolveToolResultAfterHook,
  formatMissingToolApprovalUiDenial,
  resolvePreToolAskApproval,
  approvalGranted,
  approvalReason,
} from './loop/tool-helpers.mjs';
import { repairTranscriptBeforeProviderSend } from './loop/transcript-repair.mjs';
import { classifyTerminationReason } from './loop/termination.mjs';
import { prepareProviderRequest } from './loop/request-boundary.mjs';
import { projectProviderRequest } from './loop/request-projection.mjs';
import { createNoToolTurnResolver } from './loop/no-tool-turn.mjs';
import { buildToolCallAssistantMessage, commitAssistantMessage } from './loop/assistant-commit.mjs';
import { traceProviderSend, traceOutputTruncation, traceLoopPhaseTiming } from './loop/diagnostics.mjs';
import { createEagerDispatcher } from './eager-dispatch.mjs';
import { sendWithRecovery } from './send-with-recovery.mjs';
import { resetAccountProbePacing } from '../providers/account-pool.mjs';
import { stripInlineImages } from './image-strip-recovery.mjs';
import { processToolBatch } from './tool-batch.mjs';
import { _buildRouteRoundReminder } from './manager/rules-cache.mjs';
import { runWithProviderRequestToolsScope } from '../../../../session-runtime/provider-request-tools.mjs';

// Facade re-exports: these symbols moved to split modules under ./loop/ but
// remain part of loop.mjs's public surface (imported by scripts/tests and other
// runtime modules). Re-export the already-imported local bindings so every
// existing import path keeps working (no duplicate module binding).
export {
  preDispatchDenyForSession,
  repairTranscriptBeforeProviderSend,
  normalizeHookUpdatedToolOutput,
  resolveToolResultAfterHook,
  formatMissingToolApprovalUiDenial,
  resolvePreToolAskApproval,
  approvalGranted,
  approvalReason,
};

// Consecutive identical-AND-failing tool calls (same name+args, error result)
// tolerated across iterations before the loop refuses to re-execute and steers
// the model to change approach. This guards deterministic failures, not the
// length of a task that keeps making progress.
const REPEAT_FAIL_LIMIT = 3;

/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 * sendOpts may include:
 *   - `effort` (provider-specific)
 *   - `fast` (boolean)
 *   - `sessionId` — enables runtime liveness markers (optional)
 *   - `signal` — AbortSignal; checked at each iteration boundary and after each
 *                tool. When aborted, throws SessionClosedError so the ask
 *                wrapper can propagate a clean cancellation.
 *   - `onStageChange(stage)` / `onStreamDelta()` — forwarded to provider.send for heartbeats
 *   - `liveProjection` — when true, Agent sessions keep provider onTextDelta / mid-turn text
 */

// Agent mid-turn text is suppressed unless THIS send explicitly requested a
// live projection. The request is a send-opt (`liveProjection`) — never a
// durable session field — so a transient Agent pane cannot leak into later
// silent dispatches or stored session JSON. The standalone surface still
// flips `interactiveSessionSurface` on the in-memory session; honor that
// in-process hint without treating it as something dispatch should persist.
export function shouldSuppressAgentMidTurnText(sessionRef, opts = {}) {
  if (!isAgentOwner(sessionRef)) return false;
  if (opts?.liveProjection === true) return false;
  if (sessionRef?.interactiveSessionSurface === true) return false;
  return true;
}

export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
  // An explicit request asks for a current answer. Let the account pool
  // re-measure quota it recorded as exhausted instead of refusing from the old
  // reading — once per loop entry, not per provider round inside the turn.
  resetAccountProbePacing();
  let iterations = 0;
  let toolCallsTotal = 0;
  let lastUsage;
  let firstTurnUsage;
  let response;
  let lastSendTools = tools;
  let contextOverflowRetryUsed = false;
  // Set when a provider context-overflow refusal triggers the in-turn
  // reactive compact retry below; consumed by the next pre-send compact pass
  // so its telemetry/events carry trigger:'reactive' (distinct from the
  // proactive pre-send pressure trigger). Cleared after that pass reads it.
  let reactiveOverflowRetryPending = false;
  const opts = sendOpts || {};
  const sessionId = opts.sessionId || null;
  const signal = opts.signal || null;
  const sessionAgent = opts.session?.agent;
  const forcedFirstTool = opts.forcedFirstTool ?? null;
  // Opaque providerState passthrough. The loop never inspects provider-native
  // payloads; the originating provider owns them. Stateful Responses
  // providers may use it for continuation anchors.
  let providerState = opts.providerState ?? undefined;
  let providerStateUpdated = false;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : null;
      // Preserve any structured abort reason (SessionClosedError,
      // StreamStalledAbortError, etc.). Fallback to SessionClosedError
      // when the reason is not an Error instance.
      if (reason) throw reason;
      throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
    }
  };
  const sessionRef = opts.session || null;
  let _providerPrefixGuardState = sessionRef?._providerPrefixGuardState || null;
  const _cacheBreakTraceKeys = new Set();
  // Provider tool snapshots are request-loop state, never durable session
  // state. Older builds persisted this field, which let a resumed session
  // keep advertising a retired schema even after session.tools was rebuilt.
  if (sessionRef && Object.hasOwn(sessionRef, '_providerToolSurfaceSnapshot')) {
    delete sessionRef._providerToolSurfaceSnapshot;
  }
  let _fixedProviderToolSurface = null;
  const loopUsageMetricsEpoch = () => Number(sessionRef?.usageMetricsEpoch) || 0;
  const loopUsageMetricsTurnId = () => Number(sessionRef?.usageMetricsTurnId) || 0;
  // Sub-agent (worker/heavy-worker/reviewer/…) sessions
  // drop mid-turn assistant preamble text outright. Only the final
  // <final-answer> reply is consumed by Lead, so any "Now let me…" prose
  // that precedes a tool call is pure noise — both for live surfacing AND
  // for the agent's own history (where it re-enters context as input
  // tokens on every later turn). Drop it at the runtime, no model-side rule:
  //   - streaming  : opts.onTextDelta suppressed (token-by-token preamble)
  //   - buffered   : opts.onAssistantText skipped (response.content below)
  //   - history    : tool-call turn content blanked before messages.push
  // Reasoning/thinking deltas, tool calls, and the final answer are kept.
  // Provider onTextDelta is restored only when live projection was
  // explicitly requested for THIS send (`opts.liveProjection`). Absence
  // of that flag preserves the silent Agent path even if a tracker
  // wrapper was installed upstream.
  const suppressMidTurnText = shouldSuppressAgentMidTurnText(sessionRef, opts);
  if (suppressMidTurnText) opts.onTextDelta = undefined;
  // Out-of-loop transcript mutations (post-turn/manual compaction in
  // manager/compaction-runner.mjs) run where no send opts exist; they park a
  // one-shot intent on the session so the FIRST send of the next turn tags
  // its expected cache break instead of an unexplained prefix mismatch.
  if (!opts.cacheBreakIntent && typeof sessionRef?.pendingCacheBreakIntent === 'string') {
    opts.cacheBreakIntent = sessionRef.pendingCacheBreakIntent;
    delete sessionRef.pendingCacheBreakIntent;
  }
  const pushToolResultMessage = (message) => {
    messages.push(message);
    try {
      opts.onToolResult?.(message);
    } catch {}
  };
  const pendingSkillPrompts = [];
  const drainSteeringIntoMessages = createSteeringDrain({
    messages,
    opts,
    sessionId,
    onSkillPrompt: (content) => pendingSkillPrompts.push(content),
  });
  // Bounded recovery for provider turns that returned no client tool calls
  // (max-output ladder, refusal retry, provider continuation, empty-turn
  // nudge) plus the caller-facing text aggregate those recoveries build.
  const noToolTurn = createNoToolTurnResolver({
    messages,
    opts,
    sessionId,
    sessionAgent,
    suppressMidTurnText,
    drainSteering: drainSteeringIntoMessages,
  });
  // Behavioral guards bound repeated failures and unchanged observations,
  // not the number of productive iterations.
  // _editCount counts any executed tool call whose def lacks readOnlyHint
  // (i.e. edit/progress: apply_patch, bash, MCP writes, skills, ...).
  let _editCount = 0;
  // Step 2: cross-turn identical read-only call dedup. Map keyed by
  // signature(name + stableStringify(args)) → { count, firstIteration }.
  // Populated only for SUCCESSFUL read-only (eager-dispatchable) calls.
  // Bounded to 500 entries (drop-oldest / insertion order).
  const _crossTurnCalls = new Map();
  const _CROSS_TURN_CAP = 500;
  let _dedupStubTotal = 0;
  // Loop-level transport replays consumed since the last SUCCESSFUL send
  // (see send-with-recovery TRANSPORT_RETRY_MAX). The budget is per
  // sampling request, starting at retries=0 and resetting on transport
  // fallback.
  // A per-ask budget instead let one early blip in
  // a long turn leave every later iteration with zero replays.
  let _transportRetriesUsed = 0;
  // Size of the ladder the LAST failure earned (a lost uplink gets a far
  // longer one than an ordinary fault). 0 means "not chosen yet": the send
  // path falls back to its default budget for display.
  let _transportRetryMax = 0;
  let _imageStripUsed = false;
  // One-shot repair of an assistant turn whose stored reasoning replay the
  // API refuses to take back (see thinking-replay-recovery.mjs). Without it
  // that turn fails identically on every retry and the session is finished.
  let _thinkingReplayRepairUsed = false;
  let _imageStripActive = false;
  let _pendingImageStripPersistMessages = null;
  let _sendMessages = null;
  // Queued prompt/task notifications are attached after a
  // tool batch, before the continuation provider send. Normal batches drain
  // up to 'next'; a Sleep-like tool grants a 'later' flush.
  let _toolBatchJustCompleted = false;
  let _lastToolBatchEndedAt = 0;
  let _lastToolBatchHadSleep = false;
  const isSleepLikeToolCall = (call) => {
    const name = String(call?.name || call?.toolName || call?.function?.name || '').toLowerCase();
    return name === 'sleep' || name.endsWith('/sleep') || name.endsWith('.sleep');
  };
  // sessionRef.cwd is the live SSOT. The legacy positional cwd is only the
  // turn-start snapshot and becomes stale after an in-turn cwd tool call.
  cwd = resolveLiveToolCwd(cwd, sessionRef);
  // Completion, cancellation, and terminal failures end execution.
  while (true) {
    // A cwd tool call updates sessionRef in place. Refresh before building
    // this iteration's eager dispatcher and cache keys so every following
    // tool family, including apply_patch, observes the new write root.
    cwd = resolveLiveToolCwd(cwd, sessionRef);
    const _iterT0 = Date.now();
    throwIfAborted();
    // Drain queued steering/prompts BEFORE the pre-send compact check, but
    // only immediately after a tool batch has completed: queued entries
    // are attached after tool results are appended and before the recursive
    // continuation, not on arbitrary non-tool continuations (empty nudges,
    // provider pauses, etc.).
    if (_toolBatchJustCompleted) {
      drainSteeringIntoMessages('pre-send', {
        maxPriority: _lastToolBatchHadSleep ? 'later' : 'next',
      });
      _toolBatchJustCompleted = false;
      _lastToolBatchHadSleep = false;
    }
    // Drains are synchronous (also used by terminal guards). Perform the
    // policy-checked selection before the next provider snapshot instead
    // of starting detached work from a drain callback.
    while (pendingSkillPrompts.length) {
      await prepareExplicitSkills(pendingSkillPrompts.shift(), messages, sessionRef, {
        cwd,
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
      cwd,
      opts,
      signal,
      iterations,
      lastUsage,
      firstTurnUsage,
      providerState,
      reactiveOverflowRetryPending,
      fixedProviderToolSurface: _fixedProviderToolSurface,
      loopUsageMetricsTurnId,
      loopUsageMetricsEpoch,
    });
    ({ iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending } = boundary);
    _fixedProviderToolSurface = boundary.fixedProviderToolSurface;
    if (boundary.providerStateCleared) providerStateUpdated = true;
    const sendTools = boundary.sendTools;
    const requestToolScope = boundary.requestToolScope;
    const nextIteration = iterations + 1;
    opts.iteration = nextIteration;
    opts.providerState = providerState;
    // The route policy's per-round batching reminder (rules/routes/*.md,
    // `round-reminder:`). One reminder per round: a provider that delivers one
    // itself declares `deliversRoundReminder` (Anthropic takes the text from
    // opts as a turn-scoped system message; the Cursor relay appends its own)
    // and the runtime channel stays silent; for every other provider the tool
    // batch appends it as a <system-reminder> after the round's results.
    opts.roundReminder =
      _buildRouteRoundReminder({ provider: sessionRef?.provider || provider?.name || null, model }) || null;
    opts.roundReminderByProvider = provider?.constructor?.deliversRoundReminder === true;
    if (forcedFirstTool && toolCallsTotal === 0) {
      opts.toolChoice = 'required';
    } else {
      delete opts.toolChoice;
    }
    // The adapter must serialize this exact immutable list. Direct adapter
    // callers omit the flag and retain legacy live deferred resolution.
    opts.providerToolSnapshotAuthoritative = true;
    opts.providerNativeToolPrefixCount = requestToolScope.nativePrefixCount;
    lastSendTools = sendTools;
    // Eager-dispatch queue: when the provider streams a tool-call event,
    // start read-only tools immediately so execution overlaps with the
    // remaining SSE parse. Writes and unknown tools wait until send()
    // returns and run serially in the call-order loop below.
    // Eager-dispatch queue (see ./eager-dispatch.mjs): read-only tools
    // start the instant the provider streams a tool-call event; the
    // dispatcher owns pending, the intra-turn sig set, and the mutation
    // epoch, all fresh per turn.
    const eager = createEagerDispatcher({
      tools,
      cwd,
      sessionId,
      sessionRef,
      signal,
      opts,
      crossTurnCalls: _crossTurnCalls,
      getIterations: () => iterations,
      getNextIteration: () => nextIteration,
      repeatFailLimit: REPEAT_FAIL_LIMIT,
    });
    opts.onToolCall = (call) => {
      try {
        opts.onAssistantToolCallObserved?.(call, {
          eagerStarted: false,
        });
      } catch {}
      return eager.onToolCall(call);
    };
    const sendStartedAt = Date.now();
    const preSendMs = sendStartedAt - _iterT0;
    const toolResumeMs = _lastToolBatchEndedAt ? sendStartedAt - _lastToolBatchEndedAt : null;
    if (_imageStripActive && !_sendMessages) {
      _sendMessages = stripInlineImages(messages).messages;
    }
    const _providerMessageSource = _sendMessages || messages;
    const { providerMessages: _providerMessages, prefixGuardCandidate: _providerPrefixGuardCandidate } =
      projectProviderRequest({
        messages: _providerMessageSource,
        sendTools,
        opts,
        provider,
        sessionRef,
        sessionId,
        model,
        iteration: nextIteration,
        prefixGuardState: _providerPrefixGuardState,
        cacheBreakTraceKeys: _cacheBreakTraceKeys,
      });
    try {
      opts.onProviderSendStarted?.();
    } catch {}
    const _sendResult = await runWithProviderRequestToolsScope(requestToolScope, () =>
      sendWithRecovery({
        provider,
        messages: _providerMessages,
        recoveryMessages: _providerMessageSource,
        model,
        sendTools,
        tools: sendTools,
        opts,
        sessionId,
        sessionRef,
        nextIteration,
        contextOverflowRetryUsed,
        transportRetriesUsed: _transportRetriesUsed,
        transportRetryMax: _transportRetryMax,
        imageStripUsed: _imageStripUsed,
        thinkingReplayRepairUsed: _thinkingReplayRepairUsed,
        signal,
      })
    );
    const _sendEndedAt = Date.now();
    if (_sendResult.action === 'retry') {
      // Keep opts.cacheBreakIntent: the failed send never consumed the
      // tag, and the reactive-compact retry that follows IS the tagged
      // transition — deleting it here made retry-side cache_break rows
      // log intentional_transition: null.
      contextOverflowRetryUsed = true;
      reactiveOverflowRetryPending = true;
      continue;
    }
    if (_sendResult.action === 'retry_transport') {
      _transportRetriesUsed += 1;
      _transportRetryMax = Number(_sendResult.transportRetryMax) || 0;
      continue;
    }
    if (_sendResult.action === 'retry_replay_repair') {
      // The offending turn was repaired in the live transcript, so the
      // replay is rebuilt from repaired history and the session keeps the
      // fix. No transport budget is consumed: nothing was generated.
      _thinkingReplayRepairUsed = true;
      continue;
    }
    if (_sendResult.action === 'retry_image_strip') {
      _transportRetriesUsed += 1;
      _imageStripUsed = true;
      _imageStripActive = true;
      _pendingImageStripPersistMessages = Array.isArray(_sendResult.persistMessages)
        ? _sendResult.persistMessages
        : null;
      if (Array.isArray(_sendResult.messages)) {
        _sendMessages = _sendResult.messages;
      }
      continue;
    }
    response = _sendResult.response;
    _providerPrefixGuardState = _providerPrefixGuardCandidate;
    if (sessionRef) sessionRef._providerPrefixGuardState = _providerPrefixGuardState;
    if (_imageStripActive) {
      if (Array.isArray(_pendingImageStripPersistMessages)) {
        messages.splice(0, messages.length, ..._pendingImageStripPersistMessages);
      } else {
        _providerPrefixGuardState = null;
        if (sessionRef) delete sessionRef._providerPrefixGuardState;
        traceCacheBreak({
          sessionId,
          iteration: nextIteration,
          classification: 'intentional',
          reason: 'image_strip_nonpersistent_rebaseline',
          source: 'image_strip_retry',
          provider: sessionRef?.provider || provider?.name || null,
          model: model || null,
          previousCount: _providerMessages.length,
          nextCount: messages.length,
        });
      }
      _imageStripActive = false;
      _pendingImageStripPersistMessages = null;
    }
    opts.onToolCall = undefined;
    delete opts.cacheBreakIntent;
    contextOverflowRetryUsed = false;
    // A completed send ends the outage this budget was covering; the next
    // iteration is a fresh request and must get the full replay budget
    // again (mirrors contextOverflowRetryUsed above).
    _transportRetriesUsed = 0;
    _transportRetryMax = 0;
    delete opts._stallRetryBudget;
    _imageStripUsed = false;
    _sendMessages = null;
    // Capture opaque state for the next turn only when the provider
    // explicitly returned the field. Absence means "no update"; an own
    // property with null/undefined means "clear".
    if (response && Object.hasOwn(response, 'providerState')) {
      providerState = response.providerState;
      providerStateUpdated = true;
    }
    iterations = nextIteration;
    traceProviderSend({
      sessionId,
      iteration: iterations,
      sendMs: Date.now() - sendStartedAt,
      preSendMs,
      toolResumeMs,
      messages,
      providerMessages: _providerMessages,
      model,
      sendTools,
      sessionAgent,
    });
    // Accumulate usage across iterations — every billable slot, not just
    // input/output. Anthropic cache_read/cache_write typically stay 0 on
    // the first iteration and surge on later ones (warm prefix reuse),
    // so aggregating only the head would silently drop most of the
    // cache-side tokens.
    if (response.usage) {
      const hadUsage = !!lastUsage;
      lastUsage = addUsage(lastUsage, response.usage);
      if (!hadUsage) {
        // Snapshot the first turn separately so callers can show
        // iter1 vs final cache-hit ratios — first iter is the
        // warm-prefix signal, final iter is the steady-state
        // efficiency signal after tool-result accumulation.
        firstTurnUsage = { ...lastUsage };
      }
    }
    // Provider may have returned despite an abort (SDKs that don't honour
    // signal) — bail before processing any of its output.
    throwIfAborted();
    traceOutputTruncation({
      sessionId,
      iteration: iterations,
      response,
      sessionAgent,
    });
    if (sessionId && opts.onUsageDelta && response.usage) {
      try {
        runWithProviderRequestToolsScope(requestToolScope, () =>
          opts.onUsageDelta(
            usageDeltaEvent({
              sessionId,
              iterationIndex: iterations,
              usageMetricsTurnId: loopUsageMetricsTurnId(),
              usageMetricsEpoch: loopUsageMetricsEpoch(),
              requestedModel: model,
              model: response.model || model,
              usage: response.usage,
              sendTools,
            })
          )
        );
      } catch {
        /* best-effort — never break the loop */
      }
    }
    // A turn without client tool calls is not automatically the final
    // answer: the provider may have hit its output ceiling, been cut by a
    // safety classifier, declared the turn unfinished, or returned nothing.
    // Each case owns a bounded recovery ladder in ./loop/no-tool-turn.mjs,
    // which either appended a recovery turn ('continue') or produced the
    // terminal response ('break').
    if (!response.toolCalls?.length) {
      const outcome = noToolTurn.resolve(response, iterations);
      response = outcome.response;
      if (outcome.action === 'continue') continue;
      break;
    }
    noToolTurn.noteToolCallTurn();
    const calls = response.toolCalls;
    toolCallsTotal += calls.length;
    // Surface any mid-turn assistant text (preamble that precedes a tool
    // call) to the UI. Providers that stream text via onTextDelta already
    // rendered it; providers that return the text only in response.content
    // (no deltas) would otherwise show nothing before the tool card. The
    // engine de-dups against already-streamed text, so emitting here is
    // safe for both paths. Sub-agent sessions suppress it entirely
    // (suppressMidTurnText) — Lead only consumes the final answer.
    if (!suppressMidTurnText && typeof response.content === 'string' && response.content.trim()) {
      try {
        opts.onAssistantText?.(response.content);
      } catch {
        /* best-effort */
      }
    }
    // Per-turn batch shape — one row per assistant turn so trace
    // consumers can derive multi-tool adoption ratio without scanning
    // every assistant message body.
    const toolBatchId = recordToolBatch(sessionId, calls, iterations);
    await Promise.resolve(onToolCall?.(iterations, calls));
    const _assistantTurnMsg = buildToolCallAssistantMessage(response, {
      calls,
      suppressMidTurnText,
      opts,
    });
    commitAssistantMessage(messages, _assistantTurnMsg, opts);
    try {
      opts.onToolPhaseStarted?.();
    } catch {}
    const _toolsT0 = Date.now();
    ({ dedupStubTotal: _dedupStubTotal, editCount: _editCount } = await processToolBatch({
      calls,
      messages,
      tools,
      cwd,
      sessionId,
      sessionRef,
      signal,
      opts,
      iterations,
      assistantTurnMsg: _assistantTurnMsg,
      toolBatchId,
      pending: eager.pending,
      epoch: eager.epoch,
      startEagerRun: eager.startEagerRun,
      crossTurnCalls: _crossTurnCalls,
      crossTurnCap: _CROSS_TURN_CAP,
      dedupStubTotal: _dedupStubTotal,
      editCount: _editCount,
      sessionAgent,
      pushToolResultMessage,
      throwIfAborted,
      repeatFailLimit: REPEAT_FAIL_LIMIT,
    }));
    const _toolsEndedAt = Date.now();
    try {
      opts.onToolPhaseCompleted?.({
        iteration: nextIteration,
        calls: calls.length,
        elapsedMs: _toolsEndedAt - _toolsT0,
      });
    } catch {}
    traceLoopPhaseTiming({
      iteration: nextIteration,
      preSendMs,
      sendMs: _sendEndedAt - sendStartedAt,
      toolsMs: _toolsEndedAt - _toolsT0,
      calls: calls.length,
    });
    _lastToolBatchEndedAt = _toolsEndedAt;
    _toolBatchJustCompleted = true;
    noToolTurn.noteToolBatchCompleted();
    _lastToolBatchHadSleep = calls.some(isSleepLikeToolCall);
  }
  // Classify WHY the loop ended so agent-tool can promote an empty/abnormal
  // finish to an explicit Lead-facing error instead of a silent empty
  // "completed" (see classifyTerminationReason in ./loop/termination.mjs).
  const terminationReason = classifyTerminationReason(response, {
    sessionAgent,
  });
  return {
    ...response,
    usage: lastUsage || response.usage,
    lastTurnUsage: response.usage,
    lastSendTools,
    firstTurnUsage: firstTurnUsage || response.usage,
    iterations,
    toolCallsTotal,
    providerState,
    providerStateUpdated,
    terminationReason,
    providerContinuations: noToolTurn.providerContinuations,
  };
}
