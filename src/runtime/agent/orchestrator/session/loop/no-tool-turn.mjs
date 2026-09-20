// Resolution of a provider turn that returned NO client tool calls.
//
// Such a turn is not automatically the final answer: the provider may have hit
// its output ceiling, been cut by a safety classifier, explicitly declared the
// turn unfinished, or returned nothing at all. Each case owns a bounded
// recovery ladder, and every ladder must terminate — an unbounded one turns a
// deterministic provider state into an infinite loop.
//
// The resolver owns the per-turn text/recovery counters because the same state
// decides both the recovery and the caller-facing aggregate; the loop reports
// tool-call turns and completed tool batches back so the counters that reset at
// those boundaries stay accurate.
import { HIDDEN_AGENT_NAMES } from './hidden-agents.mjs';
import { INCOMPLETE_STOP_REASONS, isOutputLimitStopReason, providerContinuationSignal } from './termination.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';
import { createTurnSegments } from './no-tool-turn/segments.mjs';
import { resolveOutputLimit } from './no-tool-turn/output-limit.mjs';
import { resolveRefusal } from './no-tool-turn/refusal.mjs';
import { resumeContinuation } from './no-tool-turn/continuation.mjs';
import { nudgeEmptyTurn } from './no-tool-turn/empty-nudge.mjs';

export function createNoToolTurnResolver({
  messages,
  opts,
  sessionId,
  sessionAgent,
  suppressMidTurnText,
  drainSteering,
}) {
  const segments = createTurnSegments({ messages, opts, suppressMidTurnText });
  // Per-turn recovery counters shared by the ladders.
  const state = {
    maxOutputRecoveryCount: 0,
    refusalRetryUsed: false,
    emptyNudgeStreak: 0,
    // Structured provider continuation signals honored this turn. Diagnostic
    // only; the hard iteration cap remains the sole bound on how long a
    // provider may keep declaring "not done" inside one user turn.
    providerContinuationCount: 0,
    // Continuations since the last executed tool batch — bounds the text-only
    // continuation runaway (see PROVIDER_CONTINUATION_NO_TOOL_LIMIT).
    continuationsSinceToolBatch: 0,
  };
  const trace = (iteration, kind, payload) => {
    try {
      appendAgentTrace({ sessionId, iteration, kind, payload, agent: sessionAgent || null });
    } catch {
      /* best-effort telemetry */
    }
  };
  const ladder = { state, segments, messages, sessionId, trace };

  // A no-tool message ends the turn. Unresolved tool failures remain visible
  // in history and can be reported directly without a synthetic continuation
  // turn. Earlier committed segments are re-prepended so the caller receives
  // the whole answer while history keeps only the terminal segment.
  const finishTurn = (response) => {
    if (segments.parts.length === 0) return { action: 'break', response };
    const terminalSegment = typeof response.content === 'string' ? response.content : '';
    return {
      action: 'break',
      response: {
        ...response,
        content: `${segments.parts.join('')}${terminalSegment}`,
        historyContent: terminalSegment,
        ...(state.maxOutputRecoveryCount > 0 ? { maxOutputRecoveryAttempts: state.maxOutputRecoveryCount } : {}),
      },
    };
  };

  return {
    // { action: 'continue' | 'break', response }. 'continue' means the
    // recovery appended to the transcript and the loop must re-send;
    // 'break' returns the (possibly aggregated) terminal response.
    resolve(response, iteration) {
      const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
      const stopReason = response.stopReason ?? response.stop_reason ?? null;
      const isOutputLimitStop = isOutputLimitStopReason(stopReason);
      if (hasContent && isOutputLimitStop) return resolveOutputLimit(response, ladder);
      if (stopReason === 'refusal') return resolveRefusal(response, hasContent, ladder);
      // Output-limit stops keep the bounded max-output ladder above and
      // refusals (already returned) keep the bounded refusal retry; both
      // own their own continuation semantics. No lexical/progress-text
      // heuristic is consulted.
      const continuationSignal = isOutputLimitStop ? null : providerContinuationSignal(response);
      if (
        continuationSignal &&
        resumeContinuation(response, { iteration, signal: continuationSignal, hasContent, stopReason }, ladder)
      ) {
        return { action: 'continue', response };
      }
      // Hidden roles are exempt from the empty-turn nudge: their own role
      // rules define a different output contract (pipe-separated chunker
      // output, …) and a text-only terminal turn is the correct shape —
      // nudging them produces a contradictory user message that traps the
      // model in a tool-call-blocked vs contract-required oscillation.
      if (!hasContent && !HIDDEN_AGENT_NAMES.has(sessionAgent)) {
        return nudgeEmptyTurn(
          response,
          { stopReason, isIncompleteStop: stopReason && INCOMPLETE_STOP_REASONS.has(stopReason) },
          ladder
        );
      }
      // Pending-input rule: queued user input is folded into
      // needs_follow_up before terminal completion. Commit the terminal
      // text first (beforeAppend), then resume.
      if (
        drainSteering('terminal', {
          maxPriority: 'next',
          beforeAppend: () => {
            if (segments.commitIntermediate(response) && hasContent) segments.record(response.content);
          },
        })
      ) {
        state.emptyNudgeStreak = 0;
        return { action: 'continue', response };
      }
      return finishTurn(response);
    },
    // A turn that produced tool calls is never an empty contract violation.
    noteToolCallTurn() {
      state.emptyNudgeStreak = 0;
    },
    noteToolBatchCompleted() {
      state.continuationsSinceToolBatch = 0;
      segments.clear();
    },
    get providerContinuations() {
      return state.providerContinuationCount;
    },
  };
}
