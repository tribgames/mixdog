// Lead tool surface: which tools the model sees before a session exists, and
// how that pre-session selection is replayed once one does. Extracted from
// runtime-core, which keeps the mutable session/route/mode it injects here.
import {
  applyDeferredToolSurface,
  filterDisallowedTools,
  selectDeferredTools,
} from './tool-catalog.mjs';
import { LEAD_DISALLOWED_TOOLS } from './tool-defs.mjs';
import { deferredSurfaceModeForLead, toolSpecForMode } from './effort.mjs';

export function createToolSurface({
  mgr,
  mode,
  standaloneTools,
  agentToolNames,
  getSession,
  getRoute,
  getConfig,
  cfgMod,
  loadWorkflowPack,
  activeWorkflowId,
  dataDir,
}) {
  let preSessionSurface = null;

  // A workflow that delegates to NOBODY must not advertise the agent tool: a
  // schema-visible tool policy always rejects is a guaranteed error turn.
  // The SESSION's effective workflow wins over the config-active one: headless
  // and per-session overrides (e.g. bench `workflow=solo`) never touch the
  // config default, so keying off config alone left the agent tool visible in
  // Solo sessions (observed across a full TB2.1 run: advertised, never used).
  function workflowAllowsAgents() {
    try {
      const sessionWorkflow = getSession()?.workflow;
      if (sessionWorkflow && typeof sessionWorkflow === 'object'
          && sessionWorkflow.agentsConfigured === true) {
        return Array.isArray(sessionWorkflow.agents) && sessionWorkflow.agents.length > 0;
      }
      const pack = loadWorkflowPack(cfgMod.getPluginData?.() || dataDir, activeWorkflowId(getConfig()));
      if (!pack || pack.agentsConfigured !== true) return true;
      return Array.isArray(pack.agents) && pack.agents.length > 0;
    } catch {
      return true;
    }
  }

  function modelStandaloneTools() {
    return workflowAllowsAgents()
      ? standaloneTools
      : standaloneTools.filter((tool) => !agentToolNames.has(String(tool?.name || '')));
  }

  function buildPreSessionSurface() {
    const previewTools = typeof mgr.previewSessionTools === 'function'
      ? mgr.previewSessionTools(toolSpecForMode(mode), [])
      : [];
    const tools = filterDisallowedTools(previewTools, LEAD_DISALLOWED_TOOLS);
    const surface = { tools: Array.isArray(tools) ? tools.slice() : [] };
    applyDeferredToolSurface(surface, deferredSurfaceModeForLead(mode), modelStandaloneTools(), {
      provider: getRoute().provider,
    });
    return surface;
  }

  return {
    modelStandaloneTools,
    invalidatePreSessionToolSurface() {
      preSessionSurface = null;
    },
    /** The live session once it exists; the preview surface until then. */
    activeToolSurface() {
      const session = getSession();
      if (session) return session;
      preSessionSurface ??= buildPreSessionSurface();
      return preSessionSurface;
    },
    /** Replay deferred tools the model loaded before the session existed. */
    applyPreSessionToolSelection() {
      const session = getSession();
      if (!session || !preSessionSurface) return;
      const selected = Array.isArray(preSessionSurface.deferredSelectedTools)
        ? preSessionSurface.deferredSelectedTools
        : [];
      const discovered = Array.isArray(preSessionSurface.deferredDiscoveredTools)
        ? preSessionSurface.deferredDiscoveredTools
        : [];
      const replay = [...new Set([...selected, ...discovered])];
      if (replay.length) selectDeferredTools(session, replay, deferredSurfaceModeForLead(mode));
    },
  };
}
