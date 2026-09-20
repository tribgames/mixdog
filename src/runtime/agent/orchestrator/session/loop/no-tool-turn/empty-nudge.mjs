// Empty-turn contract nudges.
//
// The agent contract (rules/agent/AGENT.md) requires either a tool call or
// final handoff text, so a public agent's empty turn is re-prompted with a
// bounded nudge. A model that answers the same nudge with another empty turn
// is in a deterministic livelock (same context in → same empty completion
// out); that failed recovery is bounded and the loop ends as an explicit
// empty termination instead.
import { writeLoopDiagnostic } from './diagnostic.mjs';

export const EMPTY_NUDGE_MAX = 3;

export function nudgeEmptyTurn(response, { stopReason, isIncompleteStop }, { state, messages, sessionId }) {
  state.emptyNudgeStreak += 1;
  if (state.emptyNudgeStreak > EMPTY_NUDGE_MAX) {
    // Livelock: identical nudges keep producing identical empty
    // completions. Stop re-prompting; classifyTerminationReason tags
    // this final empty response as 'empty' so the caller surfaces an
    // explicit error instead of a silent finish.
    writeLoopDiagnostic(
      `[loop] empty-turn nudge cap ${EMPTY_NUDGE_MAX} reached (sess=${sessionId || 'unknown'}); ending loop as empty termination.\n`
    );
    return { action: 'break', response };
  }
  messages.push({
    role: 'user',
    content: isIncompleteStop
      ? `[mixdog-runtime] Empty truncated continuation (stopReason=${stopReason}). Return the remaining final handoff; use tools only for required evidence still missing.`
      : `[mixdog-runtime] Empty response (${state.emptyNudgeStreak}/${EMPTY_NUDGE_MAX}). Return final text, or use tools only for required evidence still missing.`,
  });
  return { action: 'continue', response };
}
