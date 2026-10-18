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
  const [store, runtime, progress, tasks] = await Promise.all([
    import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
    // The import-free leaf holding the runtime map: no session manager graph.
    import('../runtime/agent/orchestrator/session/manager/runtime-state.mjs'),
    import('../runtime/agent/orchestrator/session/agent-pool-progress.mjs'),
    import('../runtime/shared/background-tasks.mjs'),
  ]);
  return {
    ...store,
    // Running rows also carry their turn's progress stamp and stage (the
    // quiet-time cue), read from the same runtime map; an idle row whose
    // agent handed off background shell work that still runs reads waiting.
    // The handed-off shell work of every row comes from one task scan. The
    // store is read with awaited I/O (a listing runs on every activity
    // change); the running set is taken once those reads are done.
    listStoredAgentWorkers: async () => {
      const rows = await store.listStoredAgentWorkersAsync({
        runningSessionIds: () => runtime.inFlightSessionActivity().working,
      });
      const awaiting = tasks.activeBackgroundTaskSessionIds({ surface: 'shell', awaitedOnly: true });
      return progress.withTurnProgress(
        rows,
        (sessionId) => runtime.runtimeState.get(sessionId),
        runtime.isTurnInFlight,
        (sessionId) => awaiting.has(sessionId)
      );
    },
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
    // The desktop service's git children start on this worker, off the loop.
    loadProcessRunner: () => import('../runtime/shared/process-runner.mjs'),
    async executeCodeGraphTool(name, args, cwd) {
      const graph = await import('../runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
      return graph.executeCodeGraphTool(name, args, cwd);
    },
  };
}
