/**
 * Whether the native result says outright that nothing was sent. User input
 * seen afterwards has nothing to make uncertain then, so the native answer
 * stands; anything else stays uncertain.
 */
export function nativeAnswerStandsAgainstUserInput(result: Record<string, unknown>): boolean {
  return result.delivery_accepted === false && result.input_may_have_executed !== true;
}

/**
 * The reply for an action the user's own input interrupted. It refuses only
 * that action: the session, its other windows and its queue carry on. The
 * effect is unknowable, so the reply never invites a replay and asks for a
 * fresh observation before any further input.
 */
export function userInputRefusalPayload(
  action: string,
  windowId: string | undefined,
  inputMayHaveExecuted: boolean,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ok: false,
    action,
    ...(windowId ? { window_id: windowId } : {}),
    code: 'user_input_active',
    effect: 'unverifiable',
    verified: false,
    input_may_have_executed: inputMayHaveExecuted,
    message: inputMayHaveExecuted
      ? 'user input interrupted this action; its input may have landed. Capture fresh state before any further input; do not replay it'
      : 'user input interrupted this action; no input was sent. Capture fresh state before acting',
    ...extra,
    verdict: { decision: 'escalate', recommended: 'recapture' },
    capture_skipped: 'user_input_active',
  };
}
