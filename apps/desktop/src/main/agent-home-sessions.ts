// Agent home threads, host side: each agent contact owns ONE persistent user
// session whose id is the fixed key of its agent id (agent-home.mjs). This
// host resolves it for every surface — this window and every paired phone go
// through the same method — creates it on the first open, and archives it when
// its agent is gone.
import {
  agentHomeSessionId,
  agentIdOfHomeSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';
import { isSessionMissingError } from './session-final-answer';

export interface AgentHomeDeps {
  /** The agent catalog (`listAgents`). */
  listAgents(): Promise<unknown>;
  /** Resolves when the session exists (live or stored); rejects with a
   *  session-missing error when it does not. */
  readSession(sessionId: string): Promise<unknown>;
  /** Reserve the session under `sessionId` with the given create params. */
  createSession(sessionId: string, params: Record<string, unknown>): Promise<void>;
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  /** Every session id this host knows, blank and untitled ones included: the
   *  store's raw rows plus live projections (never the filtered summaries). */
  knownSessionIds(): string[];
  /** Per-id definition presence from the files themselves
   *  (`agentDefinitionPresence`); anything but 'deleted' keeps a thread. */
  agentPresence(agentIds: string[]): Promise<unknown>;
  taskWorkspace(): Promise<string>;
}

/** The create-call route fields of an agent's catalog route. */
function routeParams(route: unknown): Record<string, unknown> {
  const leaf = Array.isArray(route) ? route[0] : route;
  if (!leaf || typeof leaf !== 'object') return {};
  const { provider, model, effort, fast, autoEffort, modelParameters } = leaf as Record<string, unknown>;
  if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) return {};
  return {
    provider,
    model,
    ...(typeof effort === 'string' && effort ? { effort } : {}),
    ...(typeof fast === 'boolean' ? { fast } : {}),
    ...(autoEffort === false ? { autoEffort: false } : {}),
    ...(modelParameters && typeof modelParameters === 'object' ? { modelParameters } : {}),
  };
}

export function createAgentHomeSessions(deps: AgentHomeDeps) {
  // One resolution per agent at a time: a double tap, or this window and a
  // phone opening together, join the same flight instead of racing a create.
  const opening = new Map<string, Promise<{ sessionId: string }>>();

  async function resolve(agentId: string): Promise<{ sessionId: string }> {
    const sessionId = agentHomeSessionId(agentId);
    if (!sessionId) throw new TypeError('agent id is invalid.');
    let params: Record<string, unknown> = {};
    if (agentId !== MIXY_AGENT_ID) {
      const row = contactAgentRows(await deps.listAgents()).find((agent) => agent.id === agentId);
      if (!row) throw new Error(`Agent "${agentId}" is not available.`);
      params = { ...routeParams(row.route), sessionProfile: { homeAgent: agentId } };
    }
    // Reopening a contact brings its thread back from the archive.
    await deps.setArchived(sessionId, false);
    try {
      await deps.readSession(sessionId);
      return { sessionId };
    } catch (error) {
      if (!isSessionMissingError(error)) throw error;
    }
    await deps.createSession(sessionId, {
      ...params,
      cwd: await deps.taskWorkspace(),
      desktopSession: { classification: 'task', projectPath: null },
    });
    return { sessionId };
  }

  function open(agentId: string): Promise<{ sessionId: string }> {
    const pending = opening.get(agentId);
    if (pending) return pending;
    const run = resolve(agentId).finally(() => {
      if (opening.get(agentId) === run) opening.delete(agentId);
    });
    opening.set(agentId, run);
    return run;
  }

  /** Archive the home thread of each agent whose definition is proven deleted
   *  on disk. The thread is addressed by its fixed id, so a blank home that no
   *  summary lists is archived too; the conversation stays restorable. Absence
   *  from a list read never counts: only a per-id 'deleted' answer does. */
  async function retire(agentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(agentIds)].filter((id) => id !== MIXY_AGENT_ID && agentHomeSessionId(id));
    if (!ids.length) return;
    const presence = await deps.agentPresence(ids);
    if (!presence || typeof presence !== 'object') return;
    for (const id of ids) {
      if ((presence as Record<string, unknown>)[id] === 'deleted') await deps.setArchived(agentHomeSessionId(id), true);
    }
  }

  /** Deletions that did not pass through this host (a chat's setup tool,
   *  files removed on disk): every known home thread's agent is checked. */
  function reconcile(): Promise<void> {
    return retire(
      deps
        .knownSessionIds()
        .map((sessionId) => agentIdOfHomeSession(sessionId))
        .filter(Boolean)
    );
  }

  return { open, retire, reconcile };
}
