// The surface this daemon lends to in-process desktop callers: one attach seam
// onto the local session bridge, plus lazy loaders for every module a rail or
// catalog request needs. Every entry stays an import() so a session-only daemon
// never pulls the projects, store-summary, statusline, config, document-preview
// or code-graph graphs into its startup path.
//
// Input: `getLocalSessionBridge` (the bridge outlives no single call, but it is
// created after this surface is handed to the session service).
// Output: the desktopRuntime object consumed by session-service.

export function createDesktopRuntime({ getLocalSessionBridge }) {
  return {
    async attachSessionClient(options = {}) {
      const bridge = getLocalSessionBridge();
      if (!bridge) throw new Error('daemon-local session client is unavailable');
      return bridge.attach(options);
    },
    loadProjects: () => import('./projects.mjs'),
    loadSessionStore: () => import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
    loadStatuslineSegments: () => import('../ui/statusline-segments.mjs'),
    loadConfig: () => import('../runtime/shared/config.mjs'),
    loadDocumentPreview: () => import('../runtime/office/pdf/document-preview.mjs'),
    async executeCodeGraphTool(name, args, cwd) {
      const graph = await import('../runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
      return graph.executeCodeGraphTool(name, args, cwd);
    },
  };
}
