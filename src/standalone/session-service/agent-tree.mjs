// session-service/agent-tree.mjs — Agent child catalog for the session service.
//
// Agent children are catalog metadata over ordinary daemon-owned sessions.
// Their transcript/execution state remains exclusively in the service's
// session index; this layer carries only the Parent–Child relationship and
// the public Agent routing fields needed before/after a turn. The registry
// (agent-tree/agent-registry), rehydration from stored rows
// (agent-rehydrate), child creation + turns (agent-turns) and cancellation
// (agent-cancel) are composed here into the surface and manager facades.
import { createAgentCancellation } from './agent-tree/agent-cancel.mjs';
import { createAgentRegistry } from './agent-tree/agent-registry.mjs';
import { createAgentRehydration, lastStoredAgentHandoff } from './agent-tree/agent-rehydrate.mjs';
import { createAgentTurns } from './agent-tree/agent-turns.mjs';

export { SESSION_ID_PATTERN } from './agent-tree/agent-registry.mjs';

export function createAgentTree({
  listSessions = null,
  readStoredSession = null,
  log = () => {},
  sessionOwner,
  stateBusy,
  entryForSession,
  retainUnwatched,
  createSession,
} = {}) {
  const registry = createAgentRegistry();
  const { rehydrateAgentSessions } = createAgentRehydration({ registry, listSessions, readStoredSession, log });
  const { createAgentChild, runAgentTurn } = createAgentTurns({
    registry,
    rehydrateAgentSessions,
    entryForSession,
    retainUnwatched,
    createSession,
  });
  const { cancelAgentTree, cancelAgentDescendants } = createAgentCancellation({
    registry,
    rehydrateAgentSessions,
    sessionOwner,
    entryForSession,
    log,
  });

  /** The descriptor as callers see it: status from the live runtime when one
   *  is busy, message count from the live items when present. */
  function agentDescriptor(sessionId) {
    const descriptor = registry.get(sessionId);
    if (!descriptor) return null;
    const owner = sessionOwner(descriptor.id);
    const state = owner?.runtime?.getState?.() || {};
    let status = descriptor.status || 'idle';
    if (descriptor.closed) status = descriptor.status || 'closed';
    else if (stateBusy(state)) status = 'running';
    return {
      ...descriptor,
      status,
      stage: status,
      messageCount:
        Array.isArray(state.items) && state.items.length > 0
          ? state.items.length
          : Math.max(0, Number(descriptor.messageCount) || 0),
      updatedAt: descriptor.updatedAt || Date.now(),
    };
  }

  const agentSurface = Object.freeze({
    canonical: true,
    canRun: (session) => Boolean(registry.get(session?.id)),
    createChild: createAgentChild,
    runTurn: runAgentTurn,
  });

  const agentManager = Object.freeze({
    rehydrateAgentSessions,
    descendantSessionIds: registry.agentDescendantSessionIds,
    getSession: (sessionId) => agentDescriptor(sessionId),
    listSessions: ({ includeClosed = false } = {}) =>
      registry
        .ids()
        .map(agentDescriptor)
        .filter((session) => session && (includeClosed || session.closed !== true)),
    getSessionRuntime: (sessionId) => {
      const session = agentDescriptor(sessionId);
      return session ? { stage: session.stage || session.status || 'idle' } : null;
    },
    async readSessionHandoff(sessionId) {
      const descriptor = registry.get(sessionId);
      if (!descriptor) return '';
      if (typeof descriptor.lastHandoff === 'string' && descriptor.lastHandoff.trim()) {
        return descriptor.lastHandoff;
      }
      if (typeof readStoredSession !== 'function') return '';
      const stored = await readStoredSession(descriptor.id, { includeMessages: true });
      const handoff = lastStoredAgentHandoff(stored);
      if (handoff) descriptor.lastHandoff = handoff;
      return handoff;
    },
    async closeSession(sessionId, reason = 'agent session closed') {
      await rehydrateAgentSessions();
      return cancelAgentTree(sessionId, reason);
    },
    unloadSessionRuntime: () => false,
    hideSessionFromList: () => false,
  });

  return Object.freeze({
    linkAgentDescriptor: registry.linkAgentDescriptor,
    rehydrateAgentSessions,
    agentDescriptor,
    rootOwnerSessionId: registry.rootOwnerSessionId,
    createAgentChild,
    runAgentTurn,
    cancelAgentTree,
    cancelAgentDescendants,
    agentDescendantSessionIds: registry.agentDescendantSessionIds,
    agentSurface,
    agentManager,
    hasAgentSession: registry.has,
    clear: registry.clear,
  });
}
