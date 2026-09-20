// session-create/session-options.mjs — the createSession option record for
// the current runtime state: route, tool spec, ownership/lane, workflow pack,
// memory context and compaction.
import { normalizeCompactionConfig } from '../config-helpers.mjs';
import { hasOwn } from '../session-text.mjs';
import { toolSpecForMode } from '../effort.mjs';
import { STANDALONE_DATA_DIR } from '../runtime-paths.mjs';
import { LEAD_DISALLOWED_TOOLS } from '../tool-defs.mjs';

// Ownership and permission fields an agent-owned session inherits from its profile.
function agentOwnedSessionFields(sessionProfile) {
  return {
    parentSessionId: sessionProfile?.parentSessionId || null,
    ownerSessionId: sessionProfile?.ownerSessionId || sessionProfile?.parentSessionId || null,
    visibility: 'agent-only',
    agentTag: sessionProfile?.agentTag || null,
    taskType: sessionProfile?.taskType || null,
    permission: sessionProfile?.permission || undefined,
    permissionMode: sessionProfile?.permissionMode || undefined,
    schemaAllowedTools: Array.isArray(sessionProfile?.schemaAllowedTools)
      ? sessionProfile.schemaAllowedTools
      : undefined,
  };
}

export function sessionOptions(deps, coreMemoryContext) {
  const { rt, cfgMod, activeWorkflowContext, schemaAllowedTools = null, featureDisallowedTools } = deps;
  const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
  // Load the active WORKFLOW.md pack once for both summary + context block.
  const { summary: workflow, context: workflowContext, orchestrationMode } = activeWorkflowContext(rt.config, dataDir);
  const sessionProfile = rt.sessionProfile && typeof rt.sessionProfile === 'object' ? rt.sessionProfile : null;
  const agentOwned = sessionProfile?.owner === 'agent' || sessionProfile?.visibility === 'agent-only';
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
    sourceType: agentOwned ? sessionProfile?.sourceType || 'agent' : 'lead',
    sourceName: agentOwned ? sessionProfile?.sourceName || sessionProfile?.agent || 'agent' : 'main',
    ...(rt.approvalMode ? { approvalMode: rt.approvalMode } : {}),
    clientHostPid: sessionProfile?.clientHostPid || process.pid,
    mcpScopeId: rt.mcpScopeId,
    disallowedTools: [
      ...(agentOwned ? [] : LEAD_DISALLOWED_TOOLS),
      ...(!agentOwned && rt.disallowDelegation ? ['agent'] : []),
      ...featureDisallowedTools(),
    ],
    cwd: rt.currentCwd,
    ...(rt.desktopSession && typeof rt.desktopSession === 'object' ? { desktopSession: rt.desktopSession } : {}),
    coreMemoryContext,
    workflow,
    workflowContext,
    orchestrationMode,
    fast: rt.route.fast === true,
    modelParameters: rt.route.modelParameters || {},
    contextPercent: rt.route.contextPercent,
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
