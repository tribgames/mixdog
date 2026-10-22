import {
  isProtectedContextAckMessage,
  latestActualUserInstructionIndex,
  pendingTaskNotificationIndexes,
} from './messages.mjs';

export const ACTIVE_TURN_CONTINUATION_SOURCE = 'compact-active-turn-continuation';
export const ACTIVE_TURN_CONTINUATION_ANCHOR = '<active-turn-continuation>';

function isExistingContinuation(message) {
  return (
    message?.role === 'user' &&
    (String(message?.meta?.source || '') === ACTIVE_TURN_CONTINUATION_SOURCE ||
      (typeof message.content === 'string' && message.content.includes(ACTIVE_TURN_CONTINUATION_ANCHOR)))
  );
}

function isExecutionActivity(message) {
  if (message?.role === 'tool') return true;
  return message?.role === 'assistant' && !isProtectedContextAckMessage(message);
}

function makeActiveTurnContinuationMessage() {
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      ACTIVE_TURN_CONTINUATION_ANCHOR,
      'The latest real user request or task notification was already in progress when Compact ran.',
      'The handoff and retained execution records above describe progress so far. A plan is not evidence that a tool succeeded; use the recorded outcomes.',
      'Continue from that state without repeating progress messages or completed tool calls.',
      'Use tools only for incomplete or failed work, or to recover missing evidence from an execution archive.',
      '</active-turn-continuation>',
      '</system-reminder>',
    ].join('\n'),
    meta: {
      source: ACTIVE_TURN_CONTINUATION_SOURCE,
      synthetic: true,
    },
  };
}

export function activeTurnContinuationMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  // The turn's latest input: a real user request or an unanswered task
  // notification. Only execution after it is progress of the current turn.
  const latestInputIndex = Math.max(
    latestActualUserInstructionIndex(list),
    pendingTaskNotificationIndexes(list).at(-1) ?? -1
  );
  if (latestInputIndex < 0) return null;
  const afterLatestInput = list.slice(latestInputIndex + 1);
  if (!afterLatestInput.some(isExistingContinuation) && !afterLatestInput.some(isExecutionActivity)) {
    return null;
  }
  return makeActiveTurnContinuationMessage();
}
