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
  getMcpScopeId = () => null,
  cfgMod,
  loadWorkflowPack,
  activeWorkflowId,
  dataDir,
  getFeatureDisallowedTools = () => [],
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
      if (sessionWorkflow && typeof sessionWorkflow === 'object') {
        if (typeof sessionWorkflow.delegatesAgents === 'boolean') {
          return sessionWorkflow.delegatesAgents;
        }
        // Legacy persisted sessions carry the old roster fields.
        if (sessionWorkflow.agentsConfigured === true) {
          return Array.isArray(sessionWorkflow.agents) && sessionWorkflow.agents.length > 0;
        }
      }
      const pack = loadWorkflowPack(cfgMod.getPluginData?.() || dataDir, activeWorkflowId(getConfig()));
      return !pack || pack.delegatesAgents !== false;
    } catch {
      return true;
    }
  }

  function modelStandaloneTools() {
    const workflowTools = workflowAllowsAgents()
      ? standaloneTools
      : standaloneTools.filter((tool) => !agentToolNames.has(String(tool?.name || '')));
    const denied = new Set(getFeatureDisallowedTools().map((name) => String(name || '')));
    return denied.size
      ? workflowTools.filter((tool) => !denied.has(String(tool?.name || '')))
      : workflowTools;
  }

  function buildPreSessionSurface() {
    const previewTools = typeof mgr.previewSessionTools === 'function'
      ? mgr.previewSessionTools(toolSpecForMode(mode), [], {
        mcpScopeId: getMcpScopeId(),
        modelName: getRoute().model,
      })
      : [];
    const tools = filterDisallowedTools(previewTools, [
      ...LEAD_DISALLOWED_TOOLS,
      ...getFeatureDisallowedTools(),
      ...(workflowAllowsAgents() ? [] : [...agentToolNames]),
    ]);
    const surface = { tools: Array.isArray(tools) ? tools.slice() : [], mcpScopeId: getMcpScopeId() };
    applyDeferredToolSurface(surface, deferredSurfaceModeForLead(mode), modelStandaloneTools(), {
      provider: getRoute().provider,
      model: getRoute().model,
    });
    return surface;
  }

  function activateTools(names) {
    const session = getSession();
    if (!session) return null;
    const surfaceMode = deferredSurfaceModeForLead(mode);
    applyDeferredToolSurface(session, surfaceMode, modelStandaloneTools(), {
      provider: getRoute().provider,
      model: getRoute().model,
    });
    return selectDeferredTools(session, names, surfaceMode);
  }

  return {
    modelStandaloneTools,
    activateTools,
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
