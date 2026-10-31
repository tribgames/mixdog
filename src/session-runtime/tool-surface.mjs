// Lead tool surface: which tools the model sees before a session exists, and
// how that pre-session selection is replayed once one does. runtime-core keeps
// the mutable session/route/mode it injects here.
import {
  applyDeferredToolSurface,
  filterDisallowedTools,
  selectDeferredTools,
} from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import {
  AGENT_WORKER_DENIED_TOOLS,
  finalizeSessionToolList,
} from '../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
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
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';
import { reactionDisabled } from '../runtime/agent/orchestrator/session/manager/session-tool-surface.mjs';
import { REACTION_TOOL_NAME } from '../runtime/agent/orchestrator/runtime-core/reaction-tool-defs.mjs';

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
  // The inputs the cached preview was built from (setters no longer
  // invalidate it; a config adopt or reload replaces the config object).
  let preSessionInputs = '';
  let preSessionConfig = null;
  let surfaceGeneration = 0;

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
      ...(reactionDisabled(session, isAgentOwner(session)) ? [REACTION_TOOL_NAME] : []),
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

  /** Definitions the current session's kind may hold — built-ins included —
   *  for tools a settings gate opened mid-conversation. */
  function toolDefinitionsFor(names) {
    const wanted = new Set((names || []).map(String));
    const session = getSession();
    const ownerIsAgent = isAgentOwner(session);
    const previewTools =
      typeof mgr.previewSessionTools === 'function'
        ? mgr.previewSessionTools(toolSpecForMode(mode), [], {
            mcpScopeId: getMcpScopeId(),
            modelName: getRoute().model,
            cwd: getCurrentCwd?.() || null,
          })
        : [];
    const byName = new Map();
    for (const tool of [...modelStandaloneTools(), ...filterModelToolsForProfile(previewTools, getToolProfile())]) {
      const name = String(tool?.name || '');
      if (wanted.has(name) && !byName.has(name)) byName.set(name, tool);
    }
    return finalizeSessionToolList([...byName.values()], { ownerIsAgent });
  }

  return {
    modelStandaloneTools,
    activateTools,
    toolDefinitionsFor,
    surfaceGeneration: () => surfaceGeneration,
    invalidatePreSessionToolSurface() {
      preSessionSurface = null;
      surfaceGeneration += 1;
    },
    /** The live session once it exists; the preview surface until then. */
    activeToolSurface() {
      const session = getSession();
      if (session) return session;
      const inputs = getFeatureDisallowedTools().join(',');
      if (preSessionConfig !== getConfig() || preSessionInputs !== inputs) preSessionSurface = null;
      preSessionConfig = getConfig();
      preSessionInputs = inputs;
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
