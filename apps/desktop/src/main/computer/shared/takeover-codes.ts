/** Failure codes that hand the whole desktop back to the user. The user's own
 *  input (`user_input_active`) never does: it refuses just the action it hit. */
export const TAKEOVER_CODES: readonly string[] = ['input_cleanup_unconfirmed', 'input_observation_unavailable'];
