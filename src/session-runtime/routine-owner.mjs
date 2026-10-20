/**
 * Routines are bot-based: a schedule or webhook runs in its owner bot's home
 * thread (routine-home-turn.mjs) and nowhere else. An owner that does not
 * exist — Mixy before the representative bot was created, a bot archived or
 * deleted — makes the routine paused: it does not fire, the lists show why,
 * and a new routine cannot name it.
 */
import { MIXY_AGENT_ID } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { scheduleOwnerAgentId } from './agent-home-delivery.mjs';

/** `ownerProblem` codes and the error each one raises. */
export const ROUTINE_OWNER_PROBLEMS = Object.freeze({
  'no-mixy': 'Create the representative bot first.',
  'owner-deleted': 'The bot that owns this routine no longer exists. Pick another bot.',
});

let editor = null;
async function defaultProbe() {
  if (!editor) {
    const [{ getPluginData }, { createAgentEditorApi }] = await Promise.all([
      import('../runtime/agent/orchestrator/config.mjs'),
      import('./workflow-agents-api/agent-editor.mjs'),
    ]);
    editor = createAgentEditorApi({ cfgMod: { getPluginData } });
  }
  return {
    // An undecided profile (null) counts as having Mixy: nobody is blocked by
    // a flag the host has not written yet.
    mixyExists: () => editor.getLeadStatus().created !== false,
    presence: (agentId) => editor.agentDefinitionPresence([agentId])[agentId],
  };
}

/** Why `ownerAgentId` (none = Mixy) cannot own or run a routine: a
 *  ROUTINE_OWNER_PROBLEMS code, '' when it can. Only a proven deletion
 *  counts for a bot; a read fault never pauses anything. */
export async function routineOwnerProblem(ownerAgentId, probe = null) {
  const owner = scheduleOwnerAgentId({ ownerAgentId });
  const check = probe || (await defaultProbe());
  if (owner === MIXY_AGENT_ID) return check.mixyExists() ? '' : 'no-mixy';
  return check.presence(owner) === 'deleted' ? 'owner-deleted' : '';
}

/** Rejects with the owner's problem; resolves when it can own a routine. */
export async function assertRoutineOwner(ownerAgentId, probe = null) {
  const problem = await routineOwnerProblem(ownerAgentId, probe);
  if (problem) throw new Error(ROUTINE_OWNER_PROBLEMS[problem]);
}
