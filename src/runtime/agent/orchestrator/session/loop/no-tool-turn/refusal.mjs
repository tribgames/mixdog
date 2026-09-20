// Refusal ladder: one context-changing retry after a safety-classifier stop.
import { writeLoopDiagnostic } from './diagnostic.mjs';

const REFUSAL_RECOVERY_PROMPT =
  '[mixdog-runtime] The previous completion was refused by the provider safety classifier (stopReason=refusal). Do not repeat it. Complete your assigned output within policy by omitting or reframing disallowed content; if no compliant output is possible, briefly state the refusal.';

export function resolveRefusal(response, hasContent, { state, segments, messages, sessionId }) {
  if (state.refusalRetryUsed) {
    writeLoopDiagnostic(
      `[loop] safety-classifier refusal persisted after one context-changing retry (sess=${sessionId || 'unknown'}); ending loop as refusal termination.\n`
    );
    return { action: 'break', response };
  }
  state.refusalRetryUsed = true;
  // A provider may emit harmless narration before its safety classifier
  // terminates the turn. Preserve that partial turn and its stop reason,
  // but never mistake the non-empty text for a successful completion.
  if (hasContent && segments.commitIntermediate(response)) segments.record(response.content);
  messages.push({
    role: 'user',
    content: REFUSAL_RECOVERY_PROMPT,
    meta: { source: 'refusal-recovery', attempt: 1 },
  });
  return { action: 'continue', response };
}
