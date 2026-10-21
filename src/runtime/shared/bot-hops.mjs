// Bot-to-bot chain budget. Every send a bot makes carries `hop` (stored in the
// transcript meta of the message it delivers, and in the report that answers
// it). A turn knows the hop of the submission that started it (`turnHop`,
// stamped on the session when the turn is prepared); a send made in it goes
// out at turnHop + 1. A turn started by the user or by a routine starts at 0;
// a runtime notification keeps the hop of the work it belongs to.
export const MAX_BOT_HOPS = 3;
export const BOT_HOP_LIMIT_ERROR = 'session: Bot-to-bot chain limit reached; ask the user before continuing.';

const hopOf = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

/** The hop a turn starts at: its submission's own, else (a runtime
 *  notification, `runtimeSource`) the hop the session was already at, else 0. */
export function startingTurnHop(transcriptMeta, runtimeSource, previous) {
  return hopOf(transcriptMeta?.hop) || (runtimeSource ? hopOf(previous) : 0);
}

/** Stamp the starting hop on `session` for the turn about to run. */
export function stampTurnHop(session, transcriptMeta, runtimeSource) {
  session.turnHop = startingTurnHop(transcriptMeta, runtimeSource, session.turnHop);
}

/** A bot's message steered into the running turn raises the turn's hop. */
export function raiseTurnHop(session, transcriptMeta) {
  const hop = hopOf(transcriptMeta?.hop);
  if (session && hop > hopOf(session.turnHop)) session.turnHop = hop;
}

/** The hop of the turn `session` is in. */
export const turnHopOf = (session) => hopOf(session?.turnHop);
