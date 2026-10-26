/**
 * loop-state.mjs — the agent loop's explicit per-ask state record: the
 * request-loop bookkeeping, plus the
 * helpers every phase shares (abort check, steering drain, no-tool resolver).
 */
import { SessionClosedError } from '../manager/session-errors.mjs';
import { resolveLiveToolCwd } from './tool-exec.mjs';
import { createSteeringDrain } from './steering.mjs';
import { createNoToolTurnResolver } from './no-tool-turn.mjs';
import { classifyTerminationReason } from './termination.mjs';
import { routeUsageSegments } from './usage.mjs';

// Consecutive identical-AND-failing tool calls (same name+args, error result)
// tolerated across iterations before the loop refuses to re-execute and steers
// the model to change approach. This guards deterministic failures, not the
// length of a task that keeps making progress.
export const REPEAT_FAIL_LIMIT = 3;

// Cross-turn identical read-only call dedup is bounded to this many entries
// (drop-oldest / insertion order).
export const CROSS_TURN_CAP = 500;

export function createLoopState({ provider, messages, model, tools, cwd, sendOpts }) {
  const opts = sendOpts || {};
  const sessionId = opts.sessionId || null;
  const signal = opts.signal || null;
  const sessionRef = opts.session || null;
  // Provider tool snapshots are request-loop state, never durable session
  // state. Older builds persisted this field, which let a resumed session
  // keep advertising a retired schema even after session.tools was rebuilt.
  if (sessionRef && Object.hasOwn(sessionRef, '_providerToolSurfaceSnapshot')) {
    delete sessionRef._providerToolSurfaceSnapshot;
  }
  // Out-of-loop transcript mutations (post-turn/manual compaction in
  // manager/compaction-runner.mjs) run where no send opts exist; they park a
  // one-shot intent on the session so the FIRST send of the next turn tags
  // its expected cache break instead of an unexplained prefix mismatch.
  if (!opts.cacheBreakIntent && typeof sessionRef?.pendingCacheBreakIntent === 'string') {
    opts.cacheBreakIntent = sessionRef.pendingCacheBreakIntent;
    delete sessionRef.pendingCacheBreakIntent;
  }
  const state = {
    provider,
    messages,
    model,
    tools,
    opts,
    sessionId,
    signal,
    sessionRef,
    sessionAgent: opts.session?.agent,
    forcedFirstTool: opts.forcedFirstTool ?? null,
    // sessionRef.cwd is the live SSOT. The legacy positional cwd is only the
    // turn-start snapshot and becomes stale after an in-turn cwd tool call.
    cwd: resolveLiveToolCwd(cwd, sessionRef),
    iterations: 0,
    toolCallsTotal: 0,
    // A capped turn (turn-limits.mjs): told to reply, and ended by calling tools anyway.
    turnLimitNoticed: false,
    turnLimitEnded: false,
    lastUsage: undefined,
    firstTurnUsage: undefined,
    response: undefined,
    lastStreamedChars: 0,
    lastSendTools: tools,
    contextOverflowRetryUsed: false,
    // Set when a provider context-overflow refusal triggers the in-turn
    // reactive compact retry; consumed by the next pre-send compact pass so
    // its telemetry/events carry trigger:'reactive'.
    reactiveOverflowRetryPending: false,
    // Opaque providerState passthrough. The loop never inspects
    // provider-native payloads; the originating provider owns them.
    providerState: opts.providerState ?? undefined,
    providerStateUpdated: false,
    prefixGuardState: sessionRef?._providerPrefixGuardState || null,
    cacheBreakTraceKeys: new Set(),
    fixedProviderToolSurface: null,
    // Behavioral guards bound repeated failures and unchanged observations,
    // not the number of productive iterations. editCount counts any executed
    // tool call whose def lacks readOnlyHint.
    editCount: 0,
    // Cross-turn identical read-only call dedup: signature → { count,
    // firstIteration }, populated only for SUCCESSFUL read-only calls.
    crossTurnCalls: new Map(),
    dedupStubTotal: 0,
    // Transport replays consumed since the last SUCCESSFUL send (see
    // send-with-recovery TRANSPORT_RETRY_MAX): a per-request budget, so one
    // early blip cannot leave every later iteration with zero replays.
    transportRetriesUsed: 0,
    // Size of the ladder the LAST failure earned; 0 = not chosen yet.
    transportRetryMax: 0,
    imageStripUsed: false,
    // One-shot repair of an assistant turn whose stored reasoning replay the
    // API refuses to take back (see thinking-replay-recovery.mjs).
    thinkingReplayRepairUsed: false,
    toolSchemaDropUsed: false,
    // Pending image-strip retry: identities of the images every attempt leaves
    // out until a send succeeds, and whether to heal them from history then.
    imageStrip: null,
    // Queued prompt/task notifications are attached after a tool batch,
    // before the continuation send. Normal batches drain up to 'next'; a
    // Sleep-like tool grants a 'later' flush.
    toolBatchJustCompleted: false,
    lastToolBatchEndedAt: 0,
    lastToolBatchHadSleep: false,
    pendingSkillPrompts: [],
  };
  state.throwIfAborted = () => {
    if (!signal?.aborted) return;
    const reason = signal.reason instanceof Error ? signal.reason : null;
    // Preserve any structured abort reason (SessionClosedError,
    // StreamStalledAbortError, etc.); fall back to SessionClosedError when
    // the reason is not an Error instance.
    if (reason) throw reason;
    throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
  };
  state.usageMetricsEpoch = () => Number(sessionRef?.usageMetricsEpoch) || 0;
  state.usageMetricsTurnId = () => Number(sessionRef?.usageMetricsTurnId) || 0;
  state.pushToolResultMessage = (message) => {
    messages.push(message);
    try {
      opts.onToolResult?.(message);
    } catch {
      // the tool-result observer is advisory
    }
  };
  state.drainSteering = createSteeringDrain({
    messages,
    opts,
    sessionId,
    onSkillPrompt: (content, message) => state.pendingSkillPrompts.push({ content, message }),
  });
  // Bounded recovery for provider turns that returned no client tool calls
  // (max-output ladder, refusal retry, provider continuation, empty-turn
  // nudge) plus the caller-facing text aggregate those recoveries build.
  state.noToolTurn = createNoToolTurnResolver({
    messages,
    opts,
    sessionId,
    sessionAgent: state.sessionAgent,
    drainSteering: state.drainSteering,
    // Only a provider that can offer a higher max_tokens implements this.
    escalateMaxTokens: () => state.provider?.escalatedMaxTokens?.(state.model, state.opts, state.lastSendTools) ?? null,
    // Characters the latest send put on screen through the live text stream.
    streamedChars: () => state.lastStreamedChars,
  });
  return state;
}

/** The ask result: the terminal response plus the loop's aggregate usage,
 *  iteration counts, provider state and WHY the loop ended (so agent-tool can
 *  promote an empty/abnormal finish to an explicit Lead-facing error). */
export function finishLoop(state) {
  const { response } = state;
  // A reaction-only turn is a successful completion, never an empty finish.
  const terminationReason = classifyTerminationReason(response, { sessionAgent: state.sessionAgent });
  const reactionCompleted = terminationReason === 'empty' && state.noToolTurn.reactionCompleted;
  return {
    ...response,
    usage: state.lastUsage || response.usage,
    lastTurnUsage: response.usage,
    lastSendTools: state.lastSendTools,
    firstTurnUsage: state.firstTurnUsage || response.usage,
    iterations: state.iterations,
    toolCallsTotal: state.toolCallsTotal,
    providerState: state.providerState,
    providerStateUpdated: state.providerStateUpdated,
    terminationReason: reactionCompleted ? undefined : terminationReason,
    ...(reactionCompleted ? { reactionCompleted: true } : {}),
    providerContinuations: state.noToolTurn.providerContinuations,
    ...(state.routeUsageHops?.length
      ? {
          usageSegments: routeUsageSegments(state.routeUsageHops, state.lastUsage, {
            provider: state.sessionRef?.provider,
            model: state.sessionRef?.model,
          }),
        }
      : {}),
  };
}
