// session-create/session-options.mjs — the createSession option record for
// the current runtime state: route, tool spec, ownership/lane, workflow pack,
// memory context and compaction.
import { normalizeCompactionConfig } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { hasOwn } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { toolSpecForMode } from '../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { pluginDataDir } from '../runtime-paths.mjs';
import { LEAD_DISALLOWED_TOOLS } from '../../runtime/agent/orchestrator/runtime-core/tool-defs.mjs';
import { HEADLESS_TOOL_PROFILE } from '../../runtime/agent/orchestrator/runtime-core/tool-profile.mjs';

// Ownership and permission fields an agent-owned session inherits from its profile.
function agentOwnedSessionFields(sessionProfile) {
  return {
    parentSessionId: sessionProfile?.parentSessionId || null,
    ownerSessionId: sessionProfile?.ownerSessionId || sessionProfile?.parentSessionId || null,
    visibility: 'agent-only',
    agentTag: sessionProfile?.agentTag || null,
    taskType: sessionProfile?.taskType || null,
    ...(sessionProfile?.routeFallbacks !== undefined ? { routeFallbacks: sessionProfile.routeFallbacks } : {}),
    permission: sessionProfile?.permission || undefined,
    permissionMode: sessionProfile?.permissionMode || undefined,
    schemaAllowedTools: Array.isArray(sessionProfile?.schemaAllowedTools)
      ? sessionProfile.schemaAllowedTools
      : undefined,
  };
}

export function sessionOptions(deps, coreMemoryContext) {
  const { rt, cfgMod, activeWorkflowContext, schemaAllowedTools = null, featureDisallowedTools } = deps;
  const dataDir = pluginDataDir(cfgMod);
  // Load the active WORKFLOW.md pack once for both summary + context block.
  const {
    summary: workflow,
    context: leadWorkflowContext,
    packContext,
    orchestrationMode,
  } = activeWorkflowContext(rt.config, dataDir);
  const sessionProfile = rt.sessionProfile && typeof rt.sessionProfile === 'object' ? rt.sessionProfile : null;
  const agentOwned = sessionProfile?.owner === 'agent' || sessionProfile?.visibility === 'agent-only';
  // Agent-owned sessions keep the Active Workflow block only.
  const workflowContext = agentOwned ? packContext : leadWorkflowContext;
  const callerDisallowedTools = [
    ...(agentOwned ? [] : LEAD_DISALLOWED_TOOLS),
    ...(!agentOwned && rt.disallowDelegation ? ['agent'] : []),
  ];
  const sessionOpts = {
    ...(rt.reservedSessionId ? { id: rt.reservedSessionId } : {}),
    provider: rt.route.provider,
    model: rt.route.model,
    preset: rt.route.preset || undefined,
    tools: toolSpecForMode(rt.mode),
    ...(Array.isArray(schemaAllowedTools) ? { schemaAllowedTools } : {}),
    owner: agentOwned ? 'agent' : 'cli',
    agent: agentOwned ? sessionProfile?.agent || 'worker' : 'lead',
    lane: agentOwned ? 'agent' : 'cli',
    // One-shot `mixdog exec` runs carry their own source so session catalogs
    // can keep them out of the user's resumable list.
    sourceType: agentOwned
      ? sessionProfile?.sourceType || 'agent'
      : rt.toolProfile === HEADLESS_TOOL_PROFILE
        ? 'exec'
        : 'lead',
    sourceName: agentOwned ? sessionProfile?.sourceName || sessionProfile?.agent || 'agent' : 'main',
    ...(rt.approvalMode ? { approvalMode: rt.approvalMode } : {}),
    clientHostPid: sessionProfile?.clientHostPid || process.pid,
    mcpScopeId: rt.mcpScopeId,
    callerDisallowedTools,
    disallowedTools: [...callerDisallowedTools, ...featureDisallowedTools()],
    cwd: rt.currentCwd,
    ...(rt.desktopSession && typeof rt.desktopSession === 'object' ? { desktopSession: rt.desktopSession } : {}),
    coreMemoryContext,
    workflow,
    workflowContext,
    orchestrationMode,
    fast: rt.route.fast === true,
    autoEffort: rt.route.autoEffort !== false,
    modelParameters: rt.route.modelParameters || {},
    contextPercent: rt.route.contextPercent,
    contextTokens: rt.route.contextTokens || null,
    selectedContextWindow: rt.route.selectedContextWindow || null,
    compaction:
      rt.config.compaction && typeof rt.config.compaction === 'object'
        ? normalizeCompactionConfig(rt.config.compaction)
        : undefined,
    ...(agentOwned ? agentOwnedSessionFields(sessionProfile) : {}),
  };
  if (hasOwn(rt.route, 'effort') || rt.route.effectiveEffort) {
    sessionOpts.effort = rt.route.effectiveEffort || null;
  }
  return sessionOpts;
}
