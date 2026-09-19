// Lead tool surface: which tools the model sees before a session exists, and
// how that pre-session selection is replayed once one does. Extracted from
// runtime-core, which keeps the mutable session/route/mode it injects here.
import { applyDeferredToolSurface, filterDisallowedTools, selectDeferredTools } from './tool-catalog.mjs';
import { LEAD_DISALLOWED_TOOLS } from './tool-defs.mjs';
import { deferredSurfaceModeForLead, toolSpecForMode } from './effort.mjs';
import { loadSkillToolDependencies } from './skill-tool-loading.mjs';
import { disallowedModelToolNamesForProfile, filterModelToolsForProfile } from './tool-profile.mjs';
import { configuredOrchestrationMode, sessionOrchestrationMode } from '../runtime/shared/orchestration.mjs';

export function createToolSurface({
  mgr,
  mode,
  standaloneTools,
  agentToolNames,
  getSession,
  getRoute,
  getConfig,
  getToolProfile = () => 'interactive',
  getMcpScopeId = () => null,
  getCurrentCwd = () => null,
  cfgMod,
  delegatableAgentIds,
  dataDir,
  getFeatureDisallowedTools = () => [],
}) {
  let preSessionSurface = null;

  // A live session keeps its frozen mode; a new session uses current settings.
  function workflowAllowsAgents() {
    const session = getSession();
    if (session?.id || session?.workflow || session?.orchestrationMode) {
      return sessionOrchestrationMode(session) !== 'none' && session?.workflow?.delegatesAgents !== false;
    }
    return (
      configuredOrchestrationMode(getConfig()) !== 'none' &&
      (delegatableAgentIds?.(getConfig(), cfgMod.getPluginData?.() || dataDir).length ?? 1) > 0
    );
  }

  function modelStandaloneTools() {
    const session = getSession();
    const agentOwned = session?.owner === 'agent' || session?.visibility === 'agent-only';
    const hideAgentTool = agentOwned || !workflowAllowsAgents();
    const profileTools = filterModelToolsForProfile(standaloneTools, getToolProfile());
    const workflowTools = hideAgentTool
      ? profileTools.filter((tool) => !agentToolNames.has(String(tool?.name || '')))
      : profileTools;
    const denied = new Set(getFeatureDisallowedTools().map((name) => String(name || '')));
    return denied.size ? workflowTools.filter((tool) => !denied.has(String(tool?.name || ''))) : workflowTools;
  }

  function disallowedTools() {
    const session = getSession();
    const profileCandidates = [
      ...standaloneTools,
      ...(Array.isArray(session?.tools) ? session.tools : []),
      ...(Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []),
    ];
    return [
      ...LEAD_DISALLOWED_TOOLS,
      ...disallowedModelToolNamesForProfile(profileCandidates, getToolProfile()),
      ...getFeatureDisallowedTools(),
      ...(workflowAllowsAgents() ? [] : [...agentToolNames]),
    ];
  }

  function buildPreSessionSurface() {
    const previewTools =
      typeof mgr.previewSessionTools === 'function'
        ? mgr.previewSessionTools(toolSpecForMode(mode), [], {
            mcpScopeId: getMcpScopeId(),
            modelName: getRoute().model,
            cwd: getCurrentCwd?.() || null,
          })
        : [];
    const denied = disallowedTools();
    const tools = filterDisallowedTools(filterModelToolsForProfile(previewTools, getToolProfile()), denied);
    const surface = {
      tools: Array.isArray(tools) ? tools.slice() : [],
      mcpScopeId: getMcpScopeId(),
      cwd: getCurrentCwd?.() || null,
    };
    applyDeferredToolSurface(surface, deferredSurfaceModeForLead(mode), modelStandaloneTools(), {
      provider: getRoute().provider,
      model: getRoute().model,
      disallowed: denied,
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
      disallowed: disallowedTools(),
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
      if (preSessionSurface.skillLoadedTools?.length) {
        loadSkillToolDependencies(
          {
            __toolEnvelope: true,
            result: '',
            skillToolDependencies: preSessionSurface.skillLoadedTools.map((value) => ({ type: 'tool', value })),
          },
          session,
          deferredSurfaceModeForLead(mode)
        );
      }
    },
  };
}
