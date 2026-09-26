// View seam: session.read/subscribe on a cold session serve these disk
// projections instead of materializing a runtime (see session-service.mjs
// stored-session views). Everything here is read-only and reaches storage
// through the desktop runtime's lazy store loaders, so a daemon that never
// serves a catalog request never loads them.
//
// Inputs: `desktopRuntime` (lazy module loaders) and `dataDir` (goal
// snapshots). Output: the read-only half of the session-service options.
import { listStoredActiveGoalSessionIds, readStoredGoalSnapshot } from '../session-runtime/goal-runtime.mjs';

export function createStoredSessionViews({ desktopRuntime, dataDir }) {
  return {
    // Settled identity of the files a stored projection is built from; the
    // cold-view refresh skips a session while it is unchanged.
    statStoredSession: async (sessionId) => {
      const store = await desktopRuntime.loadSessionStore();
      return store.storedSessionTranscriptStamp?.(sessionId) ?? null;
    },
    sessionExists: async (sessionId) => {
      const store = await desktopRuntime.loadSessionStore();
      return store.storedSessionExists?.(sessionId) === true;
    },
    readStoredSession: async (sessionId, options = {}) => {
      const store = await desktopRuntime.loadSessionStore();
      if (typeof store.readStoredSessionTranscript !== 'function') return null;
      return (await store.readStoredSessionTranscript(sessionId, options)) ?? null;
    },
    forgetStoredSession: async (sessionId) => {
      const store = await desktopRuntime.loadSessionStore();
      store.forgetStoredSessionTranscript?.(sessionId);
    },
    readStoredGoal: async (sessionId) =>
      readStoredGoalSnapshot({
        dataDir,
        sessionId,
      }),
    listStoredActiveGoalSessionIds: async () =>
      listStoredActiveGoalSessionIds({
        dataDir,
      }),
    listSessions: async (options = {}) => {
      if (options.includeAgentOnly === true) {
        // Agent discovery is metadata-only. Exact session reads/subscriptions
        // keep using the canonical session id after the user opens a worker.
        const store = await import('../runtime/agent/orchestrator/session/store.mjs');
        const summaries = store.listStoredSessionSummaries({
          refreshFromStorage: options.refreshFromStorage === true,
        });
        const viewStore = await desktopRuntime.loadSessionStore();
        const links = viewStore.listStoredAgentWorkerLinks?.() || [];
        if (!links.length) return summaries;
        const linksById = new Map(links.map((link) => [link.sessionId, link]));
        return summaries.map((row) => {
          if (row?.parentSessionId) return row;
          const link = linksById.get(row?.id);
          return link ? { ...row, ...link, id: row.id } : row;
        });
      }
      const store = await desktopRuntime.loadSessionStore();
      return store.listStoredSessionSummaries({
        refreshFromStorage: options.refreshFromStorage === true,
      });
    },
  };
}
