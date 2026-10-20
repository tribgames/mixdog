// Whose memory a session reads and writes (runtime/memory/lib/
// core-memory-access.mjs enforces it). Mixy is the Lead configuration, so the
// user's own sessions (an ordinary Lead session, Mixy's home) act as Mixy; an
// agent's home thread and its room member sessions act as that agent; a
// schedule or webhook run acts for its owning agent (`ownerAgentId`, stamped
// at creation); a delegated agent as its own agent id.
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { resolveSessionMode } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { scheduleCallerScope } from './schedule-access.mjs';

const validAgentId = (value) => {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && agentHomeSessionId(id) ? id : '';
};

/** The `memory_caller` `{ kind, agentId }` of a calling session record:
 *  'human' and 'agent' are conversations with the user, 'room-member' and
 *  'headless' unattended runs. */
export function memoryCallerScope(session) {
  const scope = scheduleCallerScope(session);
  if (scope.kind === 'human') return { kind: 'human', agentId: MIXY_AGENT_ID };
  if (scope.kind !== 'headless') return scope;
  const delegated = isAgentOwner(session) || Boolean(session?.parentSessionId);
  return {
    kind: 'headless',
    agentId: validAgentId(session?.ownerAgentId) || (delegated ? validAgentId(session?.agent) : ''),
  };
}

/** The agent whose own memory a session's prompt carries: its home thread's,
 *  room member's or run owner's agent, Mixy for the user's Lead sessions, and
 *  none for a delegated agent. `session` is the live record when there is
 *  one, else the reserved id and creation profile. */
export function injectedMemoryAgentId({ session = null, sessionId = '', profile = null } = {}) {
  return resolveSessionMode({ session, sessionId, profile }).agentId;
}
