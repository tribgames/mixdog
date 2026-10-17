// Max-output ladder.
//
// A provider max-output stop is not a completed assistant turn, even when it
// contains useful text. Preserve each partial in the provider transcript and
// grant at most MAX_OUTPUT_RECOVERY_LIMIT direct continuations before
// surfacing a hard truncation.
const MAX_OUTPUT_RECOVERY_LIMIT = 3;
const MAX_OUTPUT_EXHAUSTED_NOTICE = `[mixdog-runtime] Output remained truncated after ${MAX_OUTPUT_RECOVERY_LIMIT} continuation attempts.`;
const MAX_OUTPUT_RESUME_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where the previous text stopped.';
// A response whose stream was cut mid-text (and could not be withdrawn from
// the screen) resumes through the same ladder with its own reason.
const STREAM_CUT_RESUME_PROMPT =
  '[mixdog-runtime] The previous response was cut off by a network interruption mid-stream. Resume directly — no apology, no recap. Pick up exactly where the previous text stopped.';

function resumePrompt(response, attempt) {
  return response.streamCut === true
    ? { role: 'user', content: STREAM_CUT_RESUME_PROMPT, meta: { source: 'stream-cut-recovery', attempt } }
    : { role: 'user', content: MAX_OUTPUT_RESUME_PROMPT, meta: { source: 'max-output-recovery', attempt } };
}

export function resolveOutputLimit(response, { state, segments, messages }) {
  segments.record(response.content);
  if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
    // The partial assistant turn must be visible to the model so it can
    // resume at the exact cutoff instead of reconstructing or repeating
    // it. askSession persists this natural recovery chain;
    // historyContent below prevents the aggregate returned to callers
    // from being persisted a second time.
    segments.commitIntermediate(response);
    state.maxOutputRecoveryCount += 1;
    messages.push(resumePrompt(response, state.maxOutputRecoveryCount));
    return { action: 'continue', response };
  }
  const terminalSegment = `${response.content}\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`;
  return {
    action: 'break',
    response: {
      ...response,
      content: `${segments.parts.slice(0, -1).join('')}${terminalSegment}`,
      historyContent: terminalSegment,
      maxOutputRecoveryAttempts: state.maxOutputRecoveryCount,
    },
  };
}
