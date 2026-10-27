/**
 * Routines are bot-based: a schedule or webhook runs in its owner bot's home
 * thread (routine-home-turn.mjs) and nowhere else. An owner that does not
 * exist — Mixy before the representative bot was created, a bot archived or
 * deleted — makes the routine paused: it does not fire, the lists show why,
 * and a new routine cannot name it.
 */
import { MIXY_AGENT_ID } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { mixyExists } from '../runtime/shared/mixy-presence.mjs';
import { scheduleOwnerAgentId } from './agent-home-delivery.mjs';

/** `ownerProblem` codes and the error each one raises. */
export const ROUTINE_OWNER_PROBLEMS = Object.freeze({
  'no-mixy': 'Create the representative bot first.',
  'owner-deleted': 'The bot that owns this routine no longer exists. Pick another bot.',
});

let editor = null;
async function editorApi() {
  if (!editor) {
    const [{ getPluginData }, { createAgentEditorApi }] = await Promise.all([
      import('../runtime/agent/orchestrator/config.mjs'),
      import('./workflow-agents-api/agent-editor.mjs'),
    ]);
    editor = createAgentEditorApi({ cfgMod: { getPluginData } });
  }
  return editor;
}

/** Whether a stored schedule or webhook belongs to Mixy (ownerless rows do).
 *  Without a PostgreSQL cluster none exists, and none is started for this. */
export async function mixyOwnsRoutines() {
  const [{ pgClusterExists }, { resolvePluginData }] = await Promise.all([
    import('../runtime/memory/lib/pg/adapter.mjs'),
    import('../runtime/shared/plugin-paths.mjs'),
  ]);
  if (!pgClusterExists(resolvePluginData())) return false;
  const [{ listSchedules }, { listEndpoints }] = await Promise.all([
    import('../runtime/channels/lib/schedules-db.mjs'),
    import('../runtime/channels/lib/webhooks-db.mjs'),
  ]);
  const [schedules, webhooks] = await Promise.all([listSchedules(), listEndpoints()]);
  return [...schedules, ...webhooks].some((row) => scheduleOwnerAgentId(row) === MIXY_AGENT_ID);
}

/** Whether Mixy exists (mixy-presence.mjs, the one rule), from `status`
 *  (getLeadStatus) or a fresh read of it. `ownsRoutine`: the caller holds a
 *  stored routine of hers, so her routines need no read. Rejects when they
 *  cannot be read and nothing else decides. */
export async function readMixyExists(status = null, { ownsRoutine = false } = {}) {
  return mixyExists(status ?? (await editorApi()).getLeadStatus(), ownsRoutine ? async () => true : mixyOwnsRoutines);
}

async function defaultProbe() {
  const api = await editorApi();
  return {
    mixyExists: (ownsRoutine) => readMixyExists(null, { ownsRoutine }),
    presence: (agentId) => api.agentDefinitionPresence([agentId])[agentId],
  };
}

/** Why `ownerAgentId` (none = Mixy) cannot own or run a routine: a
 *  ROUTINE_OWNER_PROBLEMS code, '' when it can. `stored`: asked for a stored
 *  routine of that owner (a run, a list row). A routine Mixy owns is itself
 *  evidence of her, so only `created: false` pauses one; a new one needs her
 *  to exist. Only a proven deletion counts for a bot; a read fault never
 *  pauses anything (callers take a rejection as no problem). */
export async function routineOwnerProblem(ownerAgentId, probe = null, { stored = false } = {}) {
  const owner = scheduleOwnerAgentId({ ownerAgentId });
  const check = probe || (await defaultProbe());
  if (owner === MIXY_AGENT_ID) return (await check.mixyExists(stored)) ? '' : 'no-mixy';
  return check.presence(owner) === 'deleted' ? 'owner-deleted' : '';
}

/** Rejects with the owner's problem; resolves when it can own a routine. */
export async function assertRoutineOwner(ownerAgentId, probe = null) {
  const problem = await routineOwnerProblem(ownerAgentId, probe);
  if (problem) throw new Error(ROUTINE_OWNER_PROBLEMS[problem]);
}
