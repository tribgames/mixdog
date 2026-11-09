// session/agent-home.mjs
// An agent's home thread: the ONE user conversation each agent contact owns.
// Its session id is a fixed key derived from the agent id, never a stored
// pointer, so every surface (PC, phone, a restarted host) resolves the same
// session, and two concurrent first opens can only ever name the same id.

/** The primary assistant's contact: the Lead configuration itself. */
export const MIXY_AGENT_ID = 'lead';

const HOME_PREFIX = 'sess_home_';
// A normalized agent id (workflow-ids normalizeWorkflowId): underscores are
// already folded to dashes, so mapping '.' to '_' stays reversible.
const AGENT_ID = /^[a-z0-9][a-z0-9.-]*$/;
const MAX_AGENT_ID_LENGTH = 200;

/** The home session id of `agentId`, or '' when it is not a normalized id. */
export function agentHomeSessionId(agentId) {
  const id = typeof agentId === 'string' ? agentId : '';
  if (id.length > MAX_AGENT_ID_LENGTH || !AGENT_ID.test(id)) return '';
  return `${HOME_PREFIX}${id.replaceAll('.', '_')}`;
}

/** The agent id a home session belongs to, or '' for any other session. */
export function agentIdOfHomeSession(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId : '';
  if (!value.startsWith(HOME_PREFIX)) return '';
  const id = value.slice(HOME_PREFIX.length).replaceAll('_', '.');
  return agentHomeSessionId(id) === value ? id : '';
}

export function isAgentHomeSessionId(sessionId) {
  return agentIdOfHomeSession(sessionId) !== '';
}
