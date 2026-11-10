// A submitted prompt's provenance, carried apart from its presentation mode
// (`origin` on the submit options, the queue entry, the turn input and the
// stored user message's meta). Dependency-free: the desktop main process
// stamps it too (agent-room-turn.ts).

/** Real external activity presented as a task notification: an inbound
 *  channel message (Discord, Telegram, webhook event rules …). */
export const PROMPT_ORIGIN_CHANNEL = 'channel';

/** A turn the runtime starts because another bot or agent reported back: a
 *  bot-home wake (daemon.mjs `wake`) or a group-room member's relay of its
 *  reported work (agent-room-turn.ts). System-caused, though presented as a
 *  prompt. */
export const PROMPT_ORIGIN_AGENT_REPORT = 'agent-report';

const KNOWN_ORIGINS = new Set([PROMPT_ORIGIN_CHANNEL, PROMPT_ORIGIN_AGENT_REPORT]);

/** `value` when it is a known provenance, else null. */
export function promptOriginOf(value) {
  return KNOWN_ORIGINS.has(value) ? value : null;
}
