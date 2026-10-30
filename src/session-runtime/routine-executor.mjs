/**
 * A routine (schedule or webhook) may name an executor: a workflow sub-agent
 * (Worker, …) on its own configured route. Each fire is then carried out by
 * that sub-agent first, headless and to its end, and only its final report
 * goes to the owner bot's home thread, which relays it (routine-home-turn.mjs).
 * No executor = the bot does the work itself, as before.
 *
 * The executor is a delegatable workflow agent: never a bot (contact agent) or
 * Mixy, never one that is unknown or turned off — refused when the routine is
 * saved (assertRoutineExecutor) and again when it fires (a sub-agent that
 * disappeared or was turned off since fails the fire; nothing falls back).
 *
 * The run is unattended like the bot's own routine turn: it is created under a
 * session id marked as that routine's run (held-requests.mjs markUnattendedRun)
 * so the sub-agent's record carries the run stamp (human-gate/delegation.mjs):
 * it never asks, payments and permanent deletes are refused
 * (human-gate/run-policy.mjs). A sub-agent session has no `agent`, `session`
 * or `ask_user` tool (AGENT_WORKER_DENIED_TOOLS), so it can start no task
 * session and ask nobody.
 */
import { randomUUID } from 'node:crypto';
import { MIXY_AGENT_ID } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import {
  BUILTIN_SLOT_AGENT_IDS,
  normalizeWorkflowId,
} from '../runtime/agent/orchestrator/runtime-core/workflow-ids.mjs';
import { storeInlineDocumentPart, storeInlineImagePart } from '../runtime/attachments/store.mjs';
import { MIXY_BOT_ID } from '../runtime/shared/agent-store.mjs';
import { automationPromptContent } from '../runtime/shared/automation-attachments.mjs';
import { routineExecutorHeader } from '../runtime/shared/routine-trigger.mjs';
import { scheduleOwnerAgentId } from './agent-home-delivery.mjs';
import { markUnattendedRun } from './held-requests.mjs';

/** `routineExecutorProblem` codes and the error each one raises. */
export const ROUTINE_EXECUTOR_PROBLEMS = Object.freeze({
  unknown: (id) => `executor agent "${id}" is not an available sub-agent: pick one from the workflow agents`,
  'not-agent': (id) =>
    `executor agent "${id}" is a bot, not a workflow sub-agent: pick a sub-agent such as Worker, or leave it unset`,
  disabled: (id) => `executor agent "${id}" is turned off: turn it on in the workflow agents or pick another`,
});

/** The stored form of an executor id: lower-cased with dashes; null for none. */
export function normalizeExecutorAgentId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? normalizeWorkflowId(text, text.toLowerCase()) : null;
}

async function defaultProbe(id) {
  const [{ workflowHelpers }, { getPluginData, loadConfig }, { isAgentDisabled, isContactAgentId }] = await Promise.all([
    import('./boot/shared.mjs'),
    import('../runtime/agent/orchestrator/config.mjs'),
    import('../runtime/shared/agent-route-config.mjs'),
  ]);
  const dataDir = getPluginData();
  // The fresh scan: an agent made a moment ago counts.
  const listed = workflowHelpers.listCustomAgentIds(dataDir).includes(id) && !BUILTIN_SLOT_AGENT_IDS.has(id);
  const definition = listed ? workflowHelpers.loadAgentDefinition(dataDir, id) : null;
  return {
    listed: Boolean(definition),
    contact: Boolean(definition) && isContactAgentId(id, definition.kind),
    disabled: isAgentDisabled(loadConfig({ secrets: false }), id),
  };
}

/** Why `id` (normalized) cannot execute a routine: a ROUTINE_EXECUTOR_PROBLEMS
 *  code, '' when it can. `probe(id)` → `{ listed, contact, disabled }`. */
export async function routineExecutorProblem(id, probe = defaultProbe) {
  if (id === MIXY_AGENT_ID || id === MIXY_BOT_ID) return 'not-agent';
  const facts = await probe(id);
  if (!facts.listed) return 'unknown';
  if (facts.contact) return 'not-agent';
  return facts.disabled ? 'disabled' : '';
}

/** The executor id to store for a save's `executorAgentId` (null/empty = none),
 *  or the error naming why it cannot be one. */
export async function assertRoutineExecutor(value, probe = defaultProbe) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('executorAgentId must be a sub-agent id (a string) or null');
  const id = normalizeExecutorAgentId(value);
  if (!id) return null;
  const problem = await routineExecutorProblem(id, probe);
  if (problem) throw new Error(ROUTINE_EXECUTOR_PROBLEMS[problem](id));
  return id;
}

/** An inline image/PDF/Office part as the stored reference part a sub-agent's
 *  prompt may carry (handoff-attachments.mjs admits references only). */
const referencePart = (part) => (part.type === 'image' ? storeInlineImagePart(part) : storeInlineDocumentPart(part));

/**
 * Carry out one fire of routine `name` with sub-agent `agentId` and resolve its
 * final report (trimmed text). `prompt` is the routine's instructions (plus a
 * webhook's fenced payload); `ownerAgentId` the bot whose run it is. Rejects
 * when the executor is no longer valid, fails, is cancelled, or `signal` aborts.
 */
export async function runRoutineExecutor(
  {
    agentId,
    kind,
    name,
    ownerAgentId = null,
    prompt,
    // The trusted part of `prompt` (the routine's instructions): the only text
    // the executor's skills are selected from, never a webhook payload.
    skillSelection = '',
    attachments = null,
    cwd = null,
    signal = null,
  },
  { surface, probe = defaultProbe } = {}
) {
  const problem = await routineExecutorProblem(agentId, probe);
  if (problem) throw new Error(`${kind} "${name}" cannot run: ${ROUTINE_EXECUTOR_PROBLEMS[problem](agentId)}`);
  if (typeof surface?.runAgent !== 'function') throw new Error('routine run: the agent service is not running');
  const header = routineExecutorHeader({ kind, name, project: cwd ? String(cwd) : '' });
  const content = automationPromptContent(`${header}\n\n${prompt}`, attachments);
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  const attachmentParts = parts
    .slice(1)
    .map(referencePart)
    .filter(Boolean);
  // The id the executor is created under: marked as this routine's unattended
  // run for as long as it works (its record keeps the run stamp afterwards).
  const parentSessionId = `routine_exec_${randomUUID()}`;
  const unmark = markUnattendedRun(parentSessionId, {
    kind,
    agentId: scheduleOwnerAgentId({ ownerAgentId }),
    name,
  });
  try {
    const result = await surface.runAgent(
      {
        agent: agentId,
        prompt: parts[0].text,
        skillSelection: String(skillSelection ?? ''),
        ...(cwd ? { cwd: String(cwd) } : {}),
        ...(attachmentParts.length ? { attachmentParts } : {}),
      },
      { callerSessionId: parentSessionId },
      { signal }
    );
    return String(result?.content ?? '').trim();
  } catch (error) {
    // The caller's own cancellation stays as it is.
    if (signal?.aborted) throw error;
    throw new Error(`${kind} "${name}": executor agent "${agentId}" failed: ${error?.message || error}`, {
      cause: error,
    });
  } finally {
    unmark();
  }
}
