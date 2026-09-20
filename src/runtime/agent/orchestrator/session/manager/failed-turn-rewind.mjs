// manager/failed-turn-rewind.mjs
// A failed turn's retry resubmits the user's prompt. When the failed turn
// sampled nothing — the trailing model-visible message is still that prompt —
// the stale copy is rewound first so the resubmission reaches the model
// exactly once. A turn that already produced assistant/tool output is left
// intact: the retry then continues from it. The rewind is gated on the
// resubmitted text matching the trailing prompt, so a continuation prompt or a
// merged queue batch can never remove a prompt it did not repeat.
import { stripRuntimeUserContext } from '../runtime-user-context.mjs';
import { promptContentText } from './prompt-utils.mjs';

function isTextOnlyContent(content) {
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.every((part) => typeof part === 'string' || part?.type === 'text');
}

/** Index of the trailing user prompt that `prompt` repeats verbatim, or -1
 *  when the history tail was answered (assistant/tool output followed it),
 *  the texts differ, or the stored prompt carries media a text resubmission
 *  would lose. */
export function trailingUnansweredPromptIndex(messages, prompt) {
  const list = Array.isArray(messages) ? messages : [];
  const resubmitted = promptContentText(prompt).trim();
  if (!resubmitted) return -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role === 'system') continue;
    if (message?.role !== 'user') return -1;
    const { content } = stripRuntimeUserContext(message);
    if (!isTextOnlyContent(content)) return -1;
    return promptContentText(content).trim() === resubmitted ? index : -1;
  }
  return -1;
}

/** Drops the trailing unanswered copy of `prompt` from the live session.
 *  Returns whether the history shrank. */
export function rewindUnansweredPrompt(session, prompt) {
  const index = trailingUnansweredPromptIndex(session?.messages, prompt);
  if (index < 0) return false;
  session.messages = session.messages.slice(0, index);
  // The transcript shrank: the provider prefix snapshot and any chained
  // provider state re-baseline with it (same reset as the failure persist).
  session.providerState = undefined;
  delete session._providerPrefixGuardState;
  return true;
}
