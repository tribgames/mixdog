// Structured provider continuations (endTurn=false / pause_turn).
//
// Honored, but they must not sustain an unbounded text-only loop: a lead
// session was observed burning a 30-minute agent budget (26K output tokens,
// zero tool calls) on back-to-back continuations. After this many
// continuations with no intervening tool batch, the current text is accepted
// as the final answer.
import { writeLoopDiagnostic } from './diagnostic.mjs';

export const PROVIDER_CONTINUATION_NO_TOOL_LIMIT = Math.max(
  1,
  Number(process.env.MIXDOG_PROVIDER_CONTINUATION_NO_TOOL_LIMIT) || 8
);

// The provider declared the assistant turn unfinished, so this text is
// mid-turn output, not a final answer: commit it EXACTLY ONCE to history/UI
// and resume sampling in the same user turn. Returns false when the
// continuation is not honored (runaway cap, or nothing committable — a
// re-send of an unchanged transcript would livelock), leaving the turn to
// the caller's terminal handling.
export function resumeContinuation(
  response,
  { iteration, signal, hasContent, stopReason },
  { state, segments, sessionId, trace }
) {
  if (state.continuationsSinceToolBatch >= PROVIDER_CONTINUATION_NO_TOOL_LIMIT) {
    writeLoopDiagnostic(
      `[loop] provider continuation cap ${PROVIDER_CONTINUATION_NO_TOOL_LIMIT} reached without tool calls (sess=${sessionId || 'unknown'}); accepting current text as final.\n`
    );
    trace(iteration, 'steer', {
      tag: 'provider_continuation_no_tool_cap',
      count: state.continuationsSinceToolBatch,
    });
    return false;
  }
  if (!segments.commitIntermediate(response)) return false;
  if (hasContent) segments.record(response.content);
  state.providerContinuationCount += 1;
  state.continuationsSinceToolBatch += 1;
  state.emptyNudgeStreak = 0;
  trace(iteration, 'provider_continuation', {
    signal,
    stop_reason: stopReason,
    count: state.providerContinuationCount,
    content_len: typeof response.content === 'string' ? response.content.length : 0,
  });
  return true;
}
