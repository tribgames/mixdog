// The bot-to-bot chain a session acts in (bot-hops.mjs botChainOf), from
// trusted runtime state only: the session's own turn chain (stamped from the
// submission that started it) and its delegation ancestry (parentSessionId /
// ownerSessionId), never from tool input.
import { resolveSessionMode } from '../runtime/agent/orchestrator/session/agent-mode.mjs';
import { botChainOf, turnBotChainOf } from '../runtime/shared/bot-hops.mjs';

const clean = (value) => String(value ?? '').trim();

/** The agent `session` acts as, by the session-mode resolver: a Lead its
 *  resolved agent (a coding Lead Mixy), a delegated worker its role. */
export function actingAgentOf(session, sessionId = '') {
  const { agentId } = resolveSessionMode({ session, sessionId });
  return clean(agentId || session?.agent);
}

/** The chain session `sessionId` acts in, oldest first, ending with the agent
 *  it acts as (when it has one): walking parentSessionId/ownerSessionId up
 *  from it, each session contributes its current turn's chain, then the
 *  agent it acts as. The visited set ends a malformed cycle. */
export function delegationChainOf(sessionId, getSession = () => null) {
  const chain = [];
  const seen = new Set();
  for (let id = clean(sessionId); id && !seen.has(id); ) {
    seen.add(id);
    const session = getSession(id) || null;
    const acting = actingAgentOf(session, id);
    chain.unshift(...turnBotChainOf(session), ...(acting ? [acting] : []));
    id = clean(session?.parentSessionId || session?.ownerSessionId);
  }
  return botChainOf(chain);
}
