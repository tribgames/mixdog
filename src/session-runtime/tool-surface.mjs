// Lead tool surface: which tools the model sees before a session exists, and
// how that pre-session selection is replayed once one does. runtime-core keeps
// the mutable session/route/mode it injects here.
import {
  applyDeferredToolSurface,
  filterDisallowedTools,
  selectDeferredTools,
} from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { AGENT_WORKER_DENIED_TOOLS } from '../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { LEAD_DISALLOWED_TOOLS } from '../runtime/agent/orchestrator/runtime-core/tool-defs.mjs';
import { deferredSurfaceModeForLead, toolSpecForMode } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { loadSkillToolDependencies } from '../runtime/agent/orchestrator/runtime-core/skill-tool-loading.mjs';
import {
  disallowedModelToolNamesForProfile,
  filterModelToolsForProfile,
} from '../runtime/agent/orchestrator/runtime-core/tool-profile.mjs';
import { workflowDisallowsAgentTool } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { promptWorkflowOf } from '../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { configuredOrchestrationMode } from '../runtime/shared/orchestration.mjs';
import { isAgentModeSession } from '../runtime/agent/orchestrator/session/agent-mode.mjs';

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

  // A coding Lead keeps `agent` whichever agents exist (the agents reach it as
  // a listing reminder); Solo still offers it (deferred) for explicit user
  // requests. An agent-mode Lead keeps its frozen capability once live (the
  // workflow its prompt was built with, even after a mid-conversation switch)
  // and a new one gets it with current agents.
  function workflowAllowsAgents() {
    const session = getSession();
    const agentMode = isAgentModeSession(session || {});
    if (session?.id || session?.workflow || session?.orchestrationMode) {
      return !workflowDisallowsAgentTool(promptWorkflowOf(session), { agentMode });
    }
    return !agentMode || (delegatableAgentIds?.(getConfig(), cfgMod.getPluginData?.() || dataDir).length ?? 1) > 0;
  }

  function modelStandaloneTools() {
    const session = getSession();
    const agentOwned = session?.owner === 'agent' || session?.visibility === 'agent-only';
    const hideAgentTool = agentOwned || !workflowAllowsAgents();
    const profileTools = filterModelToolsForProfile(standaloneTools, getToolProfile());
    const workflowTools = hideAgentTool
      ? profileTools.filter((tool) => !agentToolNames.has(String(tool?.name || '')))
      : profileTools;
    const visibleTools = agentOwned
      ? workflowTools.filter((tool) => !AGENT_WORKER_DENIED_TOOLS.has(String(tool?.name || '').toLowerCase()))
      : workflowTools;
    const denied = new Set(getFeatureDisallowedTools().map((name) => String(name || '')));
    return denied.size ? visibleTools.filter((tool) => !denied.has(String(tool?.name || ''))) : visibleTools;
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
      orchestrationMode: configuredOrchestrationMode(getConfig()),
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
