/**
 * Whether the native result says outright that nothing was sent. User input
 * seen afterwards has nothing to make uncertain then, so the native answer
 * stands; anything else stays uncertain.
 */
export function nativeAnswerStandsAgainstUserInput(result: Record<string, unknown>): boolean {
  return result.delivery_accepted === false && result.input_may_have_executed !== true;
}

/** A foreground input the user's own input already made unsafe, refused
 *  before anything was sent. */
export class UserInputBeforeDispatch extends Error {}

/**
 * The reply for a foreground action the user's input interrupted: the session
 * yields. Only this session waits, and it continues by itself once the user
 * has been idle for the idle-resume interval (or, with that off, until the
 * user presses Resume); the reply says which, so the model neither retries at
 * once nor gives up. Works on a single-action refusal and
 * on a sequence reply that stopped on user input.
 */
export function yieldedUserInputPayload(
  payload: Record<string, unknown>,
  manualResume = false
): Record<string, unknown> {
  const sent = payload.input_may_have_executed !== false;
  return {
    ...payload,
    status: 'yielded',
    yielded: true,
    resume_mode: manualResume ? 'manual' : 'idle',
    message: `Computer Use yielded to the user's input; ${
      manualResume
        ? 'this agent is waiting for the user to press Resume on the overlay and does not continue by itself.'
        : 'this agent continues by itself once the user has been idle.'
    } ${
      sent
        ? "The user's input interrupted the action and its input may have landed; it will not be replayed."
        : 'No input was sent.'
    } Call wait_for_user, then capture fresh state before acting`,
    verdict: { decision: 'wait_for_user', recommended: 'wait_for_user' },
  };
}

/**
 * The reply for an action the user's own input interrupted. It refuses only
 * that action: the session, its other windows and its queue carry on. The
 * effect is unknowable, so the reply never invites a replay and asks for a
 * fresh observation before any further input. A foreground action's refusal
 * is turned into a yield by `yieldedUserInputPayload`.
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
