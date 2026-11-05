/** Failure codes that hand the whole desktop back to the user. The user's own
 *  input (`user_input_active`) never does: it refuses just the action it hit,
 *  and a foreground one also makes only its own session wait for the user to
 *  be idle (`ComputerUseCoordinator.yieldSession`).
 *  Neither does a failed input observer (`input_observation_unavailable`):
 *  nothing is left held, so it refuses that call, and the next call checks the
 *  observer again. */
export const TAKEOVER_CODES: readonly string[] = ['input_cleanup_unconfirmed'];
