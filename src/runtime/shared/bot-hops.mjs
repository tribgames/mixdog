// Bot-to-bot chain budget. Every send a bot makes carries `hop` (stored in the
// transcript meta of the message it delivers, and in the report that answers
// it). A turn knows the hop of the submission that started it (`turnHop`,
// stamped on the session when the turn is prepared); a send made in it goes
// out at turnHop + 1. Only a message another bot sent counts: a turn started by
// the user, a routine or a runtime notification (a task report, a wake) starts
// at 0, so a bot's reports of its own sends never use up its budget. Background
// work (a command, an agent task) launched in a bot-descended turn carries that
// turn's hop on its completion notification (`hop` in the completion meta and
// entry), and the turn the notification starts or joins resumes at it.
export const MAX_BOT_HOPS = 3;
export const BOT_HOP_LIMIT_ERROR = 'session: Bot-to-bot chain limit reached; ask the user before continuing.';

export const hopOf = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

/** The hop of the turn that made a send, from the send's own place in the chain
 *  (`hop`, as a task report or watch carries it, with its `target`): a send to
 *  another session is one hop past its turn, one to a task session the bot
 *  created only continues it. A report wakes the sender's turn back at this
 *  depth: bot-descended work resumes where it was, independent work at 0. */
export const sendDepth = ({ hop, target } = {}) => Math.max(0, hopOf(hop) - (target === 'session' ? 1 : 0));

// The bots of a chain (`botChain`): the agent ids that handed the work on,
// oldest first, the sender last. A bot's send carries the chain of its turn
// plus itself in the transcript meta of the message it delivers (like `hop`);
// the turn that message starts or joins is in that chain (`turnBotChain`), and
// a send or spawn from it may never reach a bot already in it, nor itself
// (assertBotChainTarget). A turn the user, a routine or a notification
// started begins a chain of its own.
export const botChainOf = (value) =>
  Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === 'string' && id))] : [];

// The chain of a submission the runtime takes without transcript meta of its
// own (a group-room member's turn, submitted by the desktop room host under
// the send's submission id), recorded by the sender before it is submitted.
const chainsBySubmission = new Map();
const MAX_SUBMISSION_CHAINS = 1000;

/** Record that submission `submissionId` starts or joins a turn of `chain`. */
export function rememberSubmissionBotChain(submissionId, chain) {
  const id = String(submissionId || '').trim();
  const bots = botChainOf(chain);
  if (!id || !bots.length) return;
  chainsBySubmission.set(id, bots);
  while (chainsBySubmission.size > MAX_SUBMISSION_CHAINS) {
    chainsBySubmission.delete(chainsBySubmission.keys().next().value);
  }
}

/** The chain a submission's transcript meta carries, else the one recorded for its ids. */
function submissionBotChain(transcriptMeta) {
  const carried = botChainOf(transcriptMeta?.botChain);
  if (carried.length) return carried;
  const merged = Array.isArray(transcriptMeta?.submissionIds) ? transcriptMeta.submissionIds : [];
  const ids = [transcriptMeta?.checkpointId, ...merged];
  return botChainOf(ids.flatMap((id) => chainsBySubmission.get(String(id || '')) || []));
}

/** Stamp the hop and bot chain of the submission that starts the turn (else 0 and none) on `session`. */
export function stampTurnHop(session, transcriptMeta) {
  session.turnHop = hopOf(transcriptMeta?.hop);
  session.turnBotChain = submissionBotChain(transcriptMeta);
}

/** A bot's message steered into the running turn raises the turn's hop and joins its chain. */
export function raiseTurnHop(session, transcriptMeta) {
  const hop = hopOf(transcriptMeta?.hop);
  if (session && hop > hopOf(session.turnHop)) session.turnHop = hop;
  const chain = submissionBotChain(transcriptMeta);
  if (session && chain.length) session.turnBotChain = botChainOf([...turnBotChainOf(session), ...chain]);
}

/** The hop of the turn `session` is in. */
export const turnHopOf = (session) => hopOf(session?.turnHop);

/** The bot chain of the turn `session` is in. */
export const turnBotChainOf = (session) => botChainOf(session?.turnBotChain);

/** The one check of every bot-to-bot hand-off (session send, a room seat,
 *  a contact agent spawn): `target`, the bot the work would reach, is
 *  neither `self` (the bot handing it on) nor already in `chain`. */
export function assertBotChainTarget(target, { chain = [], self = '' } = {}, prefix = 'session') {
  if (!target) return;
  if (target === self) {
    throw new Error(
      `${prefix}: the contact agent "${target}" cannot hand work to itself; do it yourself or delegate to a sub-agent`
    );
  }
  if (chain.includes(target)) {
    const path = [...chain, ...(self && chain.at(-1) !== self ? [self] : []), target];
    throw new Error(
      `${prefix}: the contact agent "${target}" is already in this delegation chain (${path.join(' → ')}); do not hand the work back, answer or delegate to a sub-agent instead`
    );
  }
}
