// Bot-to-bot chain budget. Every send a bot makes carries `hop` (stored in the
// transcript meta of the message it delivers, and in the report that answers
// it). A turn knows the hop of the submission that started it (`turnHop`,
// stamped on the session when the turn is prepared); a send made in it goes
// out at turnHop + 1. Only a message another bot sent counts: a turn started by
// the user, a routine or a runtime notification (a task report, a wake) starts
// at 0, so a bot's reports of its own sends never use up its budget.
export const MAX_BOT_HOPS = 3;
export const BOT_HOP_LIMIT_ERROR = 'session: Bot-to-bot chain limit reached; ask the user before continuing.';

const hopOf = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

/** The hop of the turn that made a send, from the send's own place in the chain
 *  (`hop`, as a task report or watch carries it, with its `target`): a send to
 *  another session is one hop past its turn, one to a task session the bot
 *  created only continues it. A report wakes the sender's turn back at this
 *  depth: bot-descended work resumes where it was, independent work at 0. */
export const sendDepth = ({ hop, target } = {}) => Math.max(0, hopOf(hop) - (target === 'session' ? 1 : 0));

/** Stamp the hop of the submission that starts the turn (else 0) on `session`. */
export function stampTurnHop(session, transcriptMeta) {
  session.turnHop = hopOf(transcriptMeta?.hop);
}

/** A bot's message steered into the running turn raises the turn's hop. */
export function raiseTurnHop(session, transcriptMeta) {
  const hop = hopOf(transcriptMeta?.hop);
  if (session && hop > hopOf(session.turnHop)) session.turnHop = hop;
}

/** The hop of the turn `session` is in. */
export const turnHopOf = (session) => hopOf(session?.turnHop);
