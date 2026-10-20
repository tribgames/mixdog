// Who may read and write which core-memory pool. Pools: common memory
// (project_id and agent_id NULL), a project's (project_id), and an agent's own
// (agent_id, project_id NULL).
//
// The caller arrives as `memory_caller` `{ kind, agentId }`, resolved by the
// session runtime from the calling session
// (session-runtime/services/memory-access.mjs); the model never supplies it. A
// call without one is the host acting for the user (desktop panels, TUI,
// admin routes).
//   - common/project memory: every caller reads it; only a conversation with
//     the user (Mixy's home, a Lead session, an agent's home thread) or the
//     host changes it;
//   - an agent's memory: that agent alone reads and writes it, from its home
//     thread or its own unattended runs; Mixy and the host may also list and
//     delete it. An unattended run (schedule, webhook, room member, delegated
//     agent) therefore writes nowhere else, so external content cannot plant
//     standing instructions in a pool another session reads.
// A deleted agent's pool is retained, unreferenced: its rows stay until the
// user deletes them, and an agent created later under the same id sees them.
import { agentHomeSessionId } from '../../agent/orchestrator/session/agent-home.mjs';

// 'host' names the absent caller explicitly; claiming it grants nothing a call
// without `memory_caller` would not.
const CALLER_KINDS = new Set(['host', 'human', 'agent', 'room-member', 'headless']);
const INTERACTIVE_KINDS = new Set(['host', 'human', 'agent']);

export const HOST_MEMORY_CALLER = Object.freeze({ kind: 'host', agentId: '', interactive: true });

/** `value` as a normalized agent id, or ''. */
export function validAgentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && agentHomeSessionId(id) ? id : '';
}

/** The caller `{ kind, agentId, interactive }` of a `memory_caller` value; an
 *  unrecognized one is an unattended run without an agent (fail closed). */
export function normalizeMemoryCaller(value) {
  if (value == null || value.kind === 'host') return HOST_MEMORY_CALLER;
  const kind = CALLER_KINDS.has(value?.kind) ? value.kind : 'headless';
  const agentId = validAgentId(value?.agentId);
  if (kind === 'agent' && !agentId) return { kind: 'headless', agentId: '', interactive: false };
  return { kind, agentId, interactive: INTERACTIVE_KINDS.has(kind) };
}

const mayManageAgents = (caller) => caller.kind === 'host' || caller.kind === 'human';

export function corePoolLabel({ projectId = null, agentId = null } = {}) {
  if (agentId) return `agent=${agentId}`;
  return `project=${projectId ?? 'COMMON'}`;
}

/** Throws unless `caller` may read agent `agentId`'s pool (none: common/project). */
export function assertCoreRead(caller, agentId) {
  if (!agentId || caller.agentId === agentId || mayManageAgents(caller)) return;
  throw new Error(`the memory of agent "${agentId}" is readable only by that agent`);
}

/** Throws unless `caller` may `op` ('add' | 'edit' | 'delete') an entry of `pool`. */
export function assertCoreWrite(caller, op, pool = {}) {
  const agentId = pool.agentId || null;
  if (agentId) {
    if (caller.agentId === agentId || (op === 'delete' && mayManageAgents(caller))) return;
    throw new Error(`memory ${op} refused: the memory of agent "${agentId}" is written only by that agent`);
  }
  if (caller.interactive) return;
  throw new Error(
    `memory ${op} refused: ${pool.projectId ? `project memory "${pool.projectId}"` : 'common memory'} changes only in a conversation with the user; an unattended run writes only its own agent memory (agent_id "self")`
  );
}
