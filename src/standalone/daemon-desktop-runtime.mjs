// The surface this daemon lends to in-process desktop callers: one attach seam
// onto the local session bridge, plus lazy loaders for every module a rail or
// catalog request needs. Every entry stays an import() so a session-only daemon
// never pulls the projects, store-summary, statusline, config, document-preview
// or code-graph graphs into its startup path.
//
// Input: `getLocalSessionBridge` (the bridge outlives no single call, but it is
// created after this surface is handed to the session service).
// Output: the desktopRuntime object consumed by session-service.

/** The stored-session reader, with the Agents pool's running state taken from
 *  this daemon's in-memory turn activity (every session runs inline here, so
 *  it is the single source of truth; worker index files only declare work). */
async function loadSessionStoreWithRuntimeActivity() {
  const [store, runtime, progress] = await Promise.all([
    import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
    // The import-free leaf holding the runtime map: no session manager graph.
    import('../runtime/agent/orchestrator/session/manager/runtime-state.mjs'),
    import('../runtime/agent/orchestrator/session/agent-pool-progress.mjs'),
  ]);
  return {
    ...store,
    // Running rows also carry their turn's progress stamp and stage (the
    // quiet-time cue), read from the same runtime map.
    listStoredAgentWorkers: () =>
      progress.withTurnProgress(
        store.listStoredAgentWorkers({ runningSessionIds: runtime.inFlightSessionActivity().working }),
        (sessionId) => runtime.runtimeState.get(sessionId),
        runtime.isTurnInFlight
      ),
  };
}

export function createDesktopRuntime({ getLocalSessionBridge }) {
  let sessionStore = null;
  return {
    async attachSessionClient(options = {}) {
      const bridge = getLocalSessionBridge();
      if (!bridge) throw new Error('daemon-local session client is unavailable');
      return bridge.attach(options);
    },
    loadProjects: () => import('../runtime/shared/projects.mjs'),
    loadWorktrees: () => import('../runtime/shared/worktrees/manager.mjs'),
    loadSessionStore() {
      // A failed import is forgotten so the next caller retries.
      sessionStore ??= loadSessionStoreWithRuntimeActivity().catch((error) => {
        sessionStore = null;
        throw error;
      });
      return sessionStore;
    },
    loadSessionSearch: () => import('../runtime/session-search/session-search-db.mjs'),
    loadStatuslineSegments: () => import('../runtime/shared/statusline/statusline-segments.mjs'),
    loadConfig: () => import('../runtime/shared/config.mjs'),
    loadDocumentPreview: () => import('../runtime/office/pdf/document-preview.mjs'),
    async executeCodeGraphTool(name, args, cwd) {
      const graph = await import('../runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
      return graph.executeCodeGraphTool(name, args, cwd);
    },
  };
}
