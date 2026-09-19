/**
 * loop-state.mjs — the agent loop's explicit per-ask state record: the
 * request-loop bookkeeping that used to live in agentLoop's closure, plus the
 * helpers every phase shares (abort check, steering drain, no-tool resolver).
 */
import { isAgentOwner } from '../../agent-owner.mjs';
import { SessionClosedError } from '../manager.mjs';
import { resolveLiveToolCwd } from './tool-exec.mjs';
import { createSteeringDrain } from './steering.mjs';
import { createNoToolTurnResolver } from './no-tool-turn.mjs';
import { classifyTerminationReason } from './termination.mjs';

// Consecutive identical-AND-failing tool calls (same name+args, error result)
// tolerated across iterations before the loop refuses to re-execute and steers
// the model to change approach. This guards deterministic failures, not the
// length of a task that keeps making progress.
export const REPEAT_FAIL_LIMIT = 3;

// Cross-turn identical read-only call dedup is bounded to this many entries
// (drop-oldest / insertion order).
export const CROSS_TURN_CAP = 500;

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
  // Sub-agent (worker/heavy-worker/reviewer/…) sessions drop mid-turn
  // assistant preamble text outright. Only the final <final-answer> reply is
  // consumed by Lead, so any "Now let me…" prose that precedes a tool call is
  // pure noise — for live surfacing AND for the agent's own history (where it
  // re-enters context as input tokens on every later turn):
  //   - streaming  : opts.onTextDelta suppressed (token-by-token preamble)
  //   - buffered   : opts.onAssistantText skipped (response.content)
  //   - history    : tool-call turn content blanked before messages.push
  // Reasoning/thinking deltas, tool calls, and the final answer are kept.
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
    suppressMidTurnText,
    // sessionRef.cwd is the live SSOT. The legacy positional cwd is only the
    // turn-start snapshot and becomes stale after an in-turn cwd tool call.
    cwd: resolveLiveToolCwd(cwd, sessionRef),
    iterations: 0,
    toolCallsTotal: 0,
    lastUsage: undefined,
    firstTurnUsage: undefined,
    response: undefined,
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
    imageStripActive: false,
    pendingImageStripPersistMessages: null,
    sendMessages: null,
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
    } catch {}
  };
  state.drainSteering = createSteeringDrain({
    messages,
    opts,
    sessionId,
    onSkillPrompt: (content) => state.pendingSkillPrompts.push(content),
  });
  // Bounded recovery for provider turns that returned no client tool calls
  // (max-output ladder, refusal retry, provider continuation, empty-turn
  // nudge) plus the caller-facing text aggregate those recoveries build.
  state.noToolTurn = createNoToolTurnResolver({
    messages,
    opts,
    sessionId,
    sessionAgent: state.sessionAgent,
    suppressMidTurnText,
    drainSteering: state.drainSteering,
  });
  return state;
}

/** The ask result: the terminal response plus the loop's aggregate usage,
 *  iteration counts, provider state and WHY the loop ended (so agent-tool can
 *  promote an empty/abnormal finish to an explicit Lead-facing error). */
export function finishLoop(state) {
  const { response } = state;
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
    terminationReason: classifyTerminationReason(response, { sessionAgent: state.sessionAgent }),
    providerContinuations: state.noToolTurn.providerContinuations,
  };
}
