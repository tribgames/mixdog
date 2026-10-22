// Max-output recovery — the single rule for every turn the provider cut at its
// output ceiling, with or without visible text.
//
// A max-output stop is not a completed assistant turn. A turn that spent its
// whole budget (typically on thinking) would repeat identically if re-sent
// unchanged, so recovery changes the request each time:
//   1. Escalation, once per progress window: re-send the same transcript with
//      a higher max_tokens when the provider has one to offer (no message
//      added; the cut partial is discarded and regenerated).
//   2. Up to MAX_OUTPUT_RECOVERY_LIMIT resume prompts at the normal
//      max_tokens, preserving any partial text in the transcript.
//   3. Then the turn ends with a visible notice that the output limit was hit.
// Real progress (a tool-call turn, a continued text turn) resets both steps.
import { isOutputLimitStopReason } from '../termination.mjs';

const MAX_OUTPUT_RECOVERY_LIMIT = 3;
const MAX_OUTPUT_EXHAUSTED_NOTICE = `[mixdog-runtime] The model hit its output limit and the response stayed truncated after ${MAX_OUTPUT_RECOVERY_LIMIT} recovery attempts.`;
const MAX_OUTPUT_RESUME_PROMPT =
  '[mixdog-runtime] Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where you left off, and break the remaining work into smaller pieces.';
// A response whose stream was cut mid-text (and could not be withdrawn from
// the screen) resumes through the same ladder with its own reason.
const STREAM_CUT_RESUME_PROMPT =
  '[mixdog-runtime] The previous response was cut off by a network interruption mid-stream. Resume directly — no apology, no recap. Pick up exactly where the previous text stopped.';

function resumePrompt(response, attempt) {
  return response.streamCut === true
    ? { role: 'user', content: STREAM_CUT_RESUME_PROMPT, meta: { source: 'stream-cut-recovery', attempt } }
    : { role: 'user', content: MAX_OUTPUT_RESUME_PROMPT, meta: { source: 'max-output-recovery', attempt } };
}

// Real progress ends the recovery window: the next cut starts a fresh ladder.
export function resetOutputLimitRecovery(state) {
  state.maxOutputRecoveryCount = 0;
  state.outputEscalationUsed = false;
}

// The escalation discards the cut response, so whatever it already put on the
// live stream must be withdrawn through the owner's retraction channel — the
// same one transport replays use. Text the owner cannot withdraw would be
// shown twice, so that case does not escalate.
async function withdrawStreamedText(opts, chars) {
  if (!(chars > 0)) return true;
  if (typeof opts?.onTextReset !== 'function') return false;
  try {
    return (await opts.onTextReset({ chars, reasoning: false, reason: 'output-limit-escalation' })) === true;
  } catch {
    return false;
  }
}

export async function resolveOutputLimit(response, { state, segments, messages, opts, escalateMaxTokens, streamedChars }) {
  const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
  if (!state.outputEscalationUsed && isOutputLimitStopReason(response.stopReason ?? response.stop_reason)) {
    state.outputEscalationUsed = true;
    // A provider may resolve the higher limit asynchronously (route lookup);
    // failing to find one only skips the escalation.
    const limit = await (async () => escalateMaxTokens())().catch(() => null);
    if (limit > 0 && (await withdrawStreamedText(opts, streamedChars()))) {
      // Taken off the shared options by the very next send (sendProviderRequest).
      opts.maxOutputTokensOverride = limit;
      return { action: 'continue', response };
    }
  }
  if (hasContent) segments.record(response.content);
  if (state.maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
    // The partial assistant turn must be visible to the model so it can
    // resume at the exact cutoff instead of reconstructing or repeating
    // it. askSession persists this natural recovery chain;
    // historyContent below prevents the aggregate returned to callers
    // from being persisted a second time. An empty cut has no output to keep.
    if (hasContent) segments.commitIntermediate(response);
    state.maxOutputRecoveryCount += 1;
    messages.push(resumePrompt(response, state.maxOutputRecoveryCount));
    return { action: 'continue', response };
  }
  const terminalSegment = hasContent ? `${response.content}\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}` : MAX_OUTPUT_EXHAUSTED_NOTICE;
  const earlier = (hasContent ? segments.parts.slice(0, -1) : segments.parts).join('');
  return {
    action: 'break',
    response: {
      ...response,
      content: `${earlier}${earlier && !hasContent ? '\n\n' : ''}${terminalSegment}`,
      historyContent: terminalSegment,
      maxOutputRecoveryAttempts: state.maxOutputRecoveryCount,
    },
  };
}
