// Who may manage automations (schedules and webhooks) from a chat, by the
// calling session's provenance. Enforced by every setup automation action
// (setup-tool/extended-actions.mjs), the chat-facing door of channel-admin:
// - the human's own sessions (an ordinary Lead session, Mixy's home) manage
//   every automation and may move one to an agent that exists;
// - another agent's home thread manages only the automations it owns and can
//   never give one away;
// - a headless run (schedule, webhook, delegated agent, or a session that
//   cannot be resolved) manages none — nor does it change any other setting
//   (setup-tool/executor.mjs refuses every mutating setup action for it).
// - a group-room member session is no background run, but it speaks for the
//   room, not for the user: it creates or changes no agent, automation or
//   other setting either.
// - an unattended run — a routine turn in a bot's home chat (Mixy's too), or
//   work it or a room started (held-requests.mjs unattendedRunOf) — is checked
//   first and only ever narrows: at most its own bot's agent scope
//   (`unattended: true`), which manages that bot's own automations and route
//   and changes no other setting.
// The app's own panels call channel-admin directly and act for the human.
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../runtime/agent/orchestrator/session/agent-room.mjs';
import { mixyDisplayName } from '../../runtime/agent/orchestrator/session/mixy-name.mjs';
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { unattendedRunOf } from '../held-requests.mjs';

const INTERACTIVE_SOURCE_TYPES = new Set(['', 'lead', 'cli']);
// What an unattended run may still change: its own bot's automations (each
// checked by assertAutomationAccess) and its own route (assertOwnAgentSettings).
const UNATTENDED_OWN_ACTIONS = new Set([
  'save_automation',
  'set_automation_enabled',
  'delete_automation',
  'run_automation',
  'set_agent_route',
]);

/** The scope by the session's id and record alone. */
function provenanceScope(session, id) {
  const member = roomMemberOfSession(id);
  if (member) return { kind: 'room-member', agentId: member.agentId };
  const homeAgent = agentIdOfHomeSession(id);
  if (homeAgent) return homeAgent === MIXY_AGENT_ID ? { kind: 'human' } : { kind: 'agent', agentId: homeAgent };
  const headless =
    !id ||
    isAgentOwner(session) ||
    Boolean(session.parentSessionId) ||
    Boolean(session.ownerSessionId && session.ownerSessionId !== id) ||
    !INTERACTIVE_SOURCE_TYPES.has(String(session.sourceType || '').toLowerCase());
  return headless ? { kind: 'headless' } : { kind: 'human' };
}

/** `{ kind: 'human' | 'agent' | 'room-member' | 'headless', agentId?, unattended? }` of a session record. */
export function scheduleCallerScope(session) {
  const id = String(session?.id || '');
  const scope = provenanceScope(session, id);
  const run = id ? unattendedRunOf(id) : null;
  if (!run || scope.kind === 'headless' || scope.kind === 'room-member') return scope;
  if (run.kind === 'room') return { kind: 'room-member', agentId: run.agentId };
  if (!run.agentId || (scope.kind === 'agent' && scope.agentId !== run.agentId)) return { kind: 'headless' };
  return { kind: 'agent', agentId: run.agentId, unattended: true };
}

/** Throws unless `scope` may `action` the `kind` ('schedule' | 'webhook')
 *  automation `current` (null when creating) with `owner` the requested owner
 *  ('' keeps the saved one). `agentIds` are the agents a transfer may name;
 *  Mixy always counts. */
export function assertAutomationAccess(
  scope,
  { kind = 'schedule', action, current = null, owner = '', agentIds = [] }
) {
  if (scope?.kind === 'room-member') throw new Error(`A group-room member cannot ${action} ${kind}s`);
  if (scope?.kind !== 'human' && scope?.kind !== 'agent') {
    throw new Error(`A background run cannot ${action} ${kind}s`);
  }
  const requested = String(owner ?? '').trim();
  const saved = current ? current.owner || MIXY_AGENT_ID : '';
  if (scope.kind === 'agent') {
    if (current && saved !== scope.agentId) {
      throw new Error(
        `${kind === 'webhook' ? 'Webhook' : 'Schedule'} "${current.name}" belongs to another agent; this thread manages only its own ${kind}s`
      );
    }
    if (requested && requested !== scope.agentId) throw new Error(`This thread cannot give a ${kind} to another agent`);
    return;
  }
  if (requested && requested !== saved && requested !== MIXY_AGENT_ID && !agentIds.includes(requested)) {
    throw new Error(`Agent "${requested}" does not exist`);
  }
}

/** Throws unless `caller` (scope `scope`) is Mixy — its home thread or an
 *  ordinary Lead session acting as 'lead': only Mixy creates, edits or
 *  deletes agent definitions from a chat. The app's own panels call the agent
 *  editor directly and act for the human. */
export function assertAgentEditorAccess(scope, caller, action) {
  const acting = String(caller?.agent || '').trim();
  if (scope?.kind === 'human' && (!acting || acting === MIXY_AGENT_ID)) return;
  const name = mixyDisplayName();
  throw new Error(
    `Only ${name} (the representative agent) can create, edit or delete agents (setup ${action}); ask the user to do it with ${name} or in the Agents settings`
  );
}

/** Throws when an agent's home thread changes another agent's settings. */
export function assertOwnAgentSettings(scope, agentId, action) {
  if (scope?.kind === 'agent' && String(agentId || '').trim() !== scope.agentId) {
    throw new Error(`This thread manages only its own agent's settings (setup ${action})`);
  }
}

/** Throws when `scope` is a headless run: it reads settings, never changes
 *  them; an unattended run changes only its own bot's automations and route. */
export function assertInteractiveCaller(scope, action) {
  if (scope?.unattended && !UNATTENDED_OWN_ACTIONS.has(action)) {
    throw new Error(`An unattended run cannot change settings (setup ${action})`);
  }
  if (scope?.kind === 'human' || scope?.kind === 'agent') return;
  if (scope?.kind === 'room-member') throw new Error(`A group-room member cannot change settings (setup ${action})`);
  throw new Error(`A background run cannot change settings (setup ${action})`);
}
