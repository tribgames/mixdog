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
import { randomUUID } from 'node:crypto';

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
  const progress = new Map();
  const progressReads = new Set();
  // Stall errors of turns the progress watchdog stopped. The runtime reports
  // such a turn only as cancelled; this lets it surface as a watchdog stop
  // with partial output instead of a user cancel.
  const watchdogStops = new Map();
  const takeWatchdogStop = (sessionId) => {
    const error = watchdogStops.get(sessionId) || null;
    watchdogStops.delete(sessionId);
    return error;
  };
  function getSessionProgressSnapshot(sessionId) {
    const runtime = sessionOwner(sessionId)?.runtime;
    if (typeof runtime?.getTurnLiveness !== 'function') return null;
    if (runtime.isWireSafe !== true) return runtime.getTurnLiveness();
    if (!progressReads.has(sessionId)) {
      progressReads.add(sessionId);
      Promise.resolve(runtime.getTurnLiveness())
        .then((snapshot) => progress.set(sessionId, snapshot))
        .catch((error) => log(`agent progress read failed session=${sessionId}: ${error?.message || error}`))
        .finally(() => progressReads.delete(sessionId));
    }
    return progress.get(sessionId) || null;
  }
  const { rehydrateAgentSessions } = createAgentRehydration({ registry, listSessions, readStoredSession, log });
  const { createAgentChild, runAgentTurn } = createAgentTurns({
    registry,
    rehydrateAgentSessions,
    entryForSession,
    retainUnwatched,
    createSession,
    takeWatchdogStop,
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
    else if (owner) {
      if (stateBusy(state)) status = 'running';
      else if (status === 'running') status = 'idle';
    }
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
    async enqueueTurn({ session, prompt, context = null }) {
      const descriptor = registry.get(session?.id);
      if (!descriptor || descriptor.closed) throw new Error('agent session is closed');
      const runtime = sessionOwner(descriptor.id)?.runtime;
      if (!runtime || !stateBusy(runtime.getState())) return null;
      const accepted = await runtime.submitAsync(String(prompt || ''), {
        id: `agent-message-${randomUUID()}`,
        mode: 'prompt',
        priority: 'next',
        context,
        transcriptMeta: { sender: 'lead' },
      });
      if (accepted === false) throw new Error('agent follow-up was not accepted');
      return { queueDepth: runtime.getState()?.queued?.length ?? null };
    },
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
      return session
        ? getSessionProgressSnapshot(sessionId) || { stage: session.stage || session.status || 'idle' }
        : null;
    },
    getSessionProgressSnapshot,
    linkParentSignalToSession(sessionId, signal) {
      const runtime = sessionOwner(sessionId)?.runtime;
      if (typeof runtime?.abort !== 'function') throw new Error(`agent runtime cannot abort session ${sessionId}`);
      const abort = () => {
        watchdogStops.set(sessionId, signal.reason);
        Promise.resolve(runtime.abort({ restorePrompt: false, reason: 'agent-watchdog' })).catch((error) => {
          log(`agent watchdog abort failed session=${sessionId}: ${error?.message || error}`);
        });
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return () => signal.removeEventListener('abort', abort);
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
    unloadSessionRuntime: (sessionId) => {
      progress.delete(sessionId);
      return false;
    },
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
