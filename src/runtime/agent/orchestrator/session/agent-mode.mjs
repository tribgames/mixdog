// session/agent-mode.mjs
// Which mode a Lead session runs in, and the agent it acts as. ONE resolver,
// used at creation, resume and every refresh:
// - agent mode: a Lead created as an agent — Mixy's home (`sess_home_lead`),
//   a contact agent's home (`sess_home_<id>`), a group-room member session
//   (`sess_rmem_<room>_<id>`), and an agent's schedule/webhook run (stamped
//   `ownerAgentId`);
// - coding mode: every other Lead (task sessions, new-task tabs) and every
//   delegated worker. `owner:'agent'` marks a delegated worker, never an
//   agent-mode Lead.
import { isAgentOwner } from '../agent-owner.mjs';
import { MIXY_AGENT_ID, agentHomeSessionId, agentIdOfHomeSession } from './agent-home.mjs';
import { roomMemberOfSession } from './agent-room.mjs';

export const AGENT_MODE = 'agent';
export const CODING_MODE = 'coding';

const validAgentId = (value) => {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && agentHomeSessionId(id) ? id : '';
};

/**
 * `{ mode, agentId }` of a session record (or create options), its reserved id
 * and creation profile. `agentId` is the agent the session acts as: '' for a
 * delegated worker, Mixy for a coding Lead.
 */
export function resolveSessionMode({ session = null, sessionId = '', profile = null } = {}) {
  if (
    isAgentOwner(session) ||
    session?.visibility === 'agent-only' ||
    profile?.owner === 'agent' ||
    profile?.visibility === 'agent-only'
  ) {
    return { mode: CODING_MODE, agentId: '' };
  }
  const id = String(session?.id || sessionId || '');
  const agentId =
    roomMemberOfSession(id)?.agentId ||
    agentIdOfHomeSession(id) ||
    validAgentId(session?.ownerAgentId) ||
    validAgentId(profile?.ownerAgentId) ||
    validAgentId(profile?.homeAgent);
  return agentId ? { mode: AGENT_MODE, agentId } : { mode: CODING_MODE, agentId: MIXY_AGENT_ID };
}

/** The persisted mode of a session record; older records resolve it. */
export function sessionModeOf(session) {
  const stored = session?.sessionMode;
  if (stored === AGENT_MODE || stored === CODING_MODE) return stored;
  return resolveSessionMode({ session }).mode;
}

export function isAgentModeSession(session) {
  return sessionModeOf(session) === AGENT_MODE;
}
