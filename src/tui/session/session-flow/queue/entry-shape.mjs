/**
 * src/tui/session/session-flow/queue/entry-shape.mjs - the normalized shape of
 * one pending queue entry. Every field the drain, the transcript and the disk
 * restore read is decided here, from the loose options a submission carries.
 */
import {
  defaultQueuePriority,
  notificationDisplayText,
  promptDisplayText,
  promptContentImageMeta,
} from '../../queue-helpers.mjs';

export function makeQueueEntry(text, options = {}, nextId) {
  const mode = options.mode || 'prompt';
  const priority = options.priority || defaultQueuePriority(mode);
  const displayText = promptDisplayText(text, options);
  const submittedAt = Number(options.submittedAt);
  return {
    id: options.id || nextId(),
    submittedAt: Number.isFinite(submittedAt) && submittedAt > 0 ? Math.round(submittedAt) : Date.now(),
    text: displayText,
    content: text,
    pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
    pastedTexts: options.pastedTexts && typeof options.pastedTexts === 'object' ? options.pastedTexts : null,
    images: promptContentImageMeta(text, options.pastedImages),
    onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
    onSettled: typeof options.onSettled === 'function' ? options.onSettled : null,
    onToolResult: typeof options.onToolResult === 'function' ? options.onToolResult : null,
    transcriptMeta:
      options.transcriptMeta && typeof options.transcriptMeta === 'object' ? { ...options.transcriptMeta } : null,
    context: options.context || null,
    mode,
    ...(options.execution && typeof options.execution === 'object' ? { execution: { ...options.execution } } : {}),
    priority,
    key: options.key || null,
    skipSlashCommands: options.skipSlashCommands === true,
    displayText: mode === 'task-notification' ? notificationDisplayText(displayText) : String(displayText || ''),
    suppressDisplay: options.suppressDisplay === true,
    // Completion resumes are consumed exactly once: Esc abandons their
    // uncommitted body instead of putting it back at the queue front.
    abortDiscardOnAbort: options.abortDiscardOnAbort === true,
    resumeCompletionKeys: Array.isArray(options.resumeCompletionKeys)
      ? options.resumeCompletionKeys.filter((key) => key != null && String(key).trim())
      : [],
    steeringPersistId: options.steeringPersistId || null,
    steeringPersistRestored: options.steeringPersistRestored === true,
    isMeta: options.isMeta === true,
    goalId: options.goalId || null,
    // Retry of a failed turn: the transcript and the session rewind the
    // failed turn's unanswered prompt before this entry runs.
    retryFailedTurn: options.retryFailedTurn === true,
  };
}
