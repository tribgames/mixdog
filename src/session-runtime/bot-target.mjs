// A bot id as the `session_id` of read, send and status: a bot's chat is a
// session of its own (`sess_home_<id>`), but the schema also lets a model name
// the bot (`bots` takes either), so the id resolves to that home chat — before
// any check of the target, so the bot-chain, hop and task-origin checks see
// the chat they would for `sess_home_<id>`. A minted session id always has an
// underscore, a normalized bot id never does (agent-home.mjs), so only ids
// shaped like a bot id are looked up.
import { MIXY_AGENT_ID, agentHomeSessionId } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { defaultListBots, quotedText } from './bot-status.mjs';

const MAX_NAMED_BOTS = 30;
/** The actions whose `session_id` may be a bot id. */
export const BOT_TARGET_ACTIONS = new Set(['read', 'send', 'status']);

/** The ids of the bots a send can reach: Mixy and every contact agent. */
async function botIds(listBots) {
  return [MIXY_AGENT_ID, ...(await listBots()).map((bot) => bot.id)];
}

/** `target`'s home chat when it is a known bot id, else `target` unchanged. */
export async function resolveBotTarget(target, listBots = defaultListBots) {
  const home = agentHomeSessionId(target);
  return home && (await botIds(listBots)).includes(target) ? home : target;
}

/** Whether `target` is shaped like a bot id (so, with no session, a mistyped one). */
export const isBotShaped = (target) => agentHomeSessionId(target) !== '';

/** The error for a bot-shaped `target` that is neither a known bot nor a session. */
export async function unknownBotError(target, listBots = defaultListBots, cause = undefined) {
  const ids = await botIds(listBots);
  const named = ids.slice(0, MAX_NAMED_BOTS).join(', ');
  const more = ids.length > MAX_NAMED_BOTS ? `, … (${ids.length - MAX_NAMED_BOTS} more)` : '';
  return new Error(
    `session: "${quotedText(target, 64)}" is neither a session nor a known bot id; bot ids: ${named}${more}; session action=list finds session ids`,
    cause ? { cause } : undefined
  );
}
