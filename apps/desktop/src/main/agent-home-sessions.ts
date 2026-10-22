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
  /** The route Mixy's thread follows (`getLeadHomeRoute`): its own, else Main's. */
  mixyRoute?(): Promise<unknown>;
  /** Resolves when the session exists (live or stored); rejects with a
   *  session-missing error when it does not. */
  readSession(sessionId: string): Promise<unknown>;
  /** Reserve the session under `sessionId` with the given create params. */
  createSession(sessionId: string, params: Record<string, unknown>): Promise<void>;
  /** Select `route` for this thread alone from its next turn (the session
   *  route surface's deferred, session-only pick: no history rewrite, no
   *  saved model settings). */
  setRoute(sessionId: string, route: Record<string, unknown>): Promise<void>;
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  /** The persisted record that a home was archived for its agent's deletion. */
  isRetired(sessionId: string): Promise<boolean>;
  setRetired(sessionId: string, retired: boolean): Promise<unknown>;
  /** Title a retired home with its bot's last known name, so the archived
   *  chat lists under that name (a user's own name for it still wins). */
  nameRetired(sessionId: string, name: string): Promise<void>;
  /** The name a deleted (archived) agent left (`archivedAgentIdentities`); '' when none. */
  archivedAgentName(agentId: string): Promise<string>;
  /** Every session id this host knows, blank and untitled ones included: the
   *  store's raw rows plus live projections (never the filtered summaries). */
  knownSessionIds(): string[];
  /** Per-id definition presence from the files themselves
   *  (`agentDefinitionPresence`); anything but 'deleted' keeps a thread. */
  agentPresence(agentIds: string[]): Promise<unknown>;
  taskWorkspace(): Promise<string>;
  /** An agent proven deleted leaves every room's members. */
  forgetRoomMember?(agentId: string): Promise<void>;
  /** Switch off (never delete) the schedules and webhooks a deleted agent owns. */
  disableAgentSchedules?(agentId: string): Promise<void>;
  /** Clear `sessionId` in place, its transcript first copied (durably) to the
   *  fresh `archiveAs`, its prompt rebuilt from the current rules; rejects
   *  while the session runs a turn. */
  clearSession(sessionId: string, archiveAs: string): Promise<void>;
  /** A fresh, unused session id for the archived copy. */
  mintArchiveId(): string;
}

export type StartOverDeps = Pick<AgentHomeDeps, 'readSession' | 'setArchived' | 'clearSession' | 'mintArchiveId'>;

/** Start `sessionId` over in place (an agent home, a room's log): its
 *  conversation so far is kept under a new archived id, returned (null when
 *  it had no user turn, so nothing was kept). The archive mark is written
 *  before the copy exists, so the copy never lists as a live chat; the clear
 *  wipes nothing until the copy is on disk. */
export async function startSessionOver(deps: StartOverDeps, sessionId: string): Promise<string | null> {
  const archiveId = deps.mintArchiveId();
  await deps.setArchived(archiveId, true);
  try {
    await deps.clearSession(sessionId, archiveId);
  } catch (error) {
    await deps.setArchived(archiveId, false).catch(() => {});
    throw error;
  }
  try {
    await deps.readSession(archiveId);
    return archiveId;
  } catch (error) {
    if (!isSessionMissingError(error)) throw error;
    await deps.setArchived(archiveId, false);
    return null;
  }
}

/** The create-call route fields of an agent's catalog route. */
export function routeParams(route: unknown): Record<string, unknown> {
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

/** The definition's route when the thread runs on another one; null when they
 *  agree. Effort counts only when the definition names one. */
function routeChange(definition: Record<string, unknown>, snapshot: unknown): Record<string, unknown> | null {
  if (!definition.provider || !snapshot || typeof snapshot !== 'object') return null;
  const current = snapshot as Record<string, unknown>;
  const differs =
    definition.provider !== current.provider ||
    definition.model !== current.model ||
    (definition.effort !== undefined && definition.effort !== current.effort);
  return differs ? definition : null;
}

export function createAgentHomeSessions(deps: AgentHomeDeps) {
  // One resolution per agent at a time: a double tap, or this window and a
  // phone opening together, join the same flight instead of racing a create.
  const opening = new Map<string, Promise<{ sessionId: string }>>();
  async function resolve(agentId: string): Promise<{ sessionId: string }> {
    const sessionId = agentHomeSessionId(agentId);
    if (!sessionId) throw new TypeError('agent id is invalid.');
    let route: Record<string, unknown> = {};
    let params: Record<string, unknown> = {};
    if (agentId === MIXY_AGENT_ID) {
      // Mixy runs on its own model (bots/mixy), Main's once it has none.
      route = routeParams(await deps.mixyRoute?.());
      params = { ...route };
    } else {
      const row = contactAgentRows(await deps.listAgents()).find((agent) => agent.id === agentId);
      if (!row) throw new Error(`Agent "${agentId}" is not available.`);
      route = routeParams(row.route);
      params = { ...route, sessionProfile: { homeAgent: agentId } };
      // A bot made again under a deleted one's id owns its thread again.
      await deps.setRetired(sessionId, false);
    }
    // Reopening a contact brings its thread back from the archive.
    await deps.setArchived(sessionId, false);
    try {
      // An existing thread follows its definition's current model and effort
      // from its next turn; earlier turns keep the model they ran on.
      const change = routeChange(route, await deps.readSession(sessionId));
      // A route the runtime refuses (provider signed out) never blocks opening.
      if (change)
        await deps
          .setRoute(sessionId, change)
          .catch((error) => console.warn('[mixdog-session] Could not refresh the agent thread route:', error));
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
   *  from a list read never counts: only a per-id 'deleted' answer does.
   *  `onTransition` archives only a home not yet retired for this deletion, so
   *  an archived one is never rewritten and a hand-restored one stays restored;
   *  an agent that exists again clears the record for its next deletion. */
  async function archiveDeleted(agentIds: readonly string[], onTransition: boolean): Promise<void> {
    const ids = [...new Set(agentIds)].filter((id) => id !== MIXY_AGENT_ID && agentHomeSessionId(id));
    if (!ids.length) return;
    const presence = await deps.agentPresence(ids);
    if (!presence || typeof presence !== 'object') return;
    for (const id of ids) {
      const sessionId = agentHomeSessionId(id);
      const state = (presence as Record<string, unknown>)[id];
      if (state === 'present') {
        if (onTransition) await deps.setRetired(sessionId, false);
        continue;
      }
      if (state !== 'deleted') continue;
      if (!(onTransition && (await deps.isRetired(sessionId)))) {
        const name = await deps.archivedAgentName(id);
        if (name) await deps.nameRetired(sessionId, name);
        await deps.setArchived(sessionId, true);
        await deps.setRetired(sessionId, true);
      }
      // Tracked apart from `retired`: the record is the schedules themselves
      // (one still on and owned by this agent means not done), so a failed
      // switch-off is retried by every later check without archiving again.
      await deps
        .disableAgentSchedules?.(id)
        .catch((error) => console.warn('[mixdog-session] Could not switch off the deleted agent schedules:', error));
      // Its membership goes with it: the one place a deletion is proven here,
      // whether the delete came through this host or a chat's setup tool.
      await deps.forgetRoomMember?.(id);
    }
  }

  /** An explicit delete event: always archives the deleted agent's home. */
  function retire(agentIds: readonly string[]): Promise<void> {
    return archiveDeleted(agentIds, false);
  }

  /** Deletions that did not pass through this host (a chat's setup tool,
   *  files removed on disk): every known home thread's agent is checked, and
   *  only a newly observed deletion archives. */
  function reconcile(): Promise<void> {
    return archiveDeleted(
      deps
        .knownSessionIds()
        .map((sessionId) => agentIdOfHomeSession(sessionId))
        .filter(Boolean),
      true
    );
  }

  /** A restored bot: its home is no longer a deleted bot's chat and leaves
   *  보관됨. Its routines stay off until the user turns them back on. */
  async function restore(agentId: string): Promise<void> {
    const sessionId = agentHomeSessionId(agentId);
    if (!sessionId || agentId === MIXY_AGENT_ID) return;
    await deps.setRetired(sessionId, false);
    await deps.setArchived(sessionId, false);
  }

  /** "대화 초기화": the agent keeps its one fixed home id — routine results,
   *  delegated work, the phone and this window all still resolve it — and
   *  the conversation so far moves to a new archived id (startSessionOver). */
  async function resetHome(agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }> {
    const { sessionId } = await resolve(agentId);
    return { sessionId, archivedSessionId: await startSessionOver(deps, sessionId) };
  }

  /** Joins the agent's open flight, so a reset and an open never race. */
  function reset(agentId: string): Promise<{ sessionId: string; archivedSessionId: string | null }> {
    const run = (opening.get(agentId) ?? Promise.resolve()).catch(() => {}).then(() => resetHome(agentId));
    const flight = run.then(({ sessionId }) => ({ sessionId }));
    opening.set(agentId, flight);
    void flight
      .catch(() => {})
      .finally(() => {
        if (opening.get(agentId) === flight) opening.delete(agentId);
      });
    return run;
  }

  return { open, reset, retire, reconcile, restore };
}
