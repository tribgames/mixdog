// session-create/session-options.mjs — the createSession option record for
// the current runtime state: route, tool spec, ownership/lane, workflow pack,
// memory context and compaction.
import { normalizeCompactionConfig } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { clean, hasOwn } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { toolSpecForMode } from '../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { STANDALONE_ROOT, pluginDataDir } from '../runtime-paths.mjs';
import { readAgentFrontmatterPermission } from '../services/agent-tool/helpers.mjs';
import { LEAD_DISALLOWED_TOOLS } from '../../runtime/agent/orchestrator/runtime-core/tool-defs.mjs';
import { HEADLESS_TOOL_PROFILE } from '../../runtime/agent/orchestrator/runtime-core/tool-profile.mjs';
import { AGENT_MODE, resolveSessionMode } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { agentIdOfHomeSession } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../runtime/agent/orchestrator/session/agent-room.mjs';
import { unattendedApprovalPort } from '../../runtime/agent/orchestrator/session/human-gate/gate.mjs';

/** Where a bot created its task session, recorded after its id in the
 *  session's `sourceName` (`agent:<id>@home|room|run`): the desktop lets the
 *  task act as the bot (its standing allows, "always allow") only when it came
 *  from the bot's own attended chat. None when the origin is anything else. */
function taskOriginSuffix(taskOrigin) {
  const from = clean(taskOrigin?.sessionId);
  if (roomMemberOfSession(from)) return '@room';
  if (unattendedApprovalPort()?.runOf?.(from)) return '@run';
  return agentIdOfHomeSession(from) === clean(taskOrigin?.agentId) ? '@home' : '';
}

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
    leadPromptParts,
    packContext,
    orchestrationMode,
  } = activeWorkflowContext(rt.config, dataDir);
  const sessionProfile = rt.sessionProfile && typeof rt.sessionProfile === 'object' ? rt.sessionProfile : null;
  const agentOwned = sessionProfile?.owner === 'agent' || sessionProfile?.visibility === 'agent-only';
  // Agent or coding mode, from the one resolver (agent-mode.mjs).
  const { mode: sessionMode, agentId: actingAgent } = resolveSessionMode({
    sessionId: rt.reservedSessionId,
    profile: sessionProfile,
  });
  // An agent's home thread: a user conversation that runs AS that agent (its
  // AGENT.md role and permission); route comes with the create call.
  const homeAgent = agentOwned ? '' : clean(sessionProfile?.homeAgent);
  const homePermission = homeAgent ? readAgentFrontmatterPermission(homeAgent, dataDir, STANDALONE_ROOT) : null;
  // A coding task session an agent created (session create): the user's own
  // Lead, tagged with its origin; `sourceName` lets the Agents list file it.
  const taskOrigin = agentOwned ? null : sessionProfile?.taskOrigin || null;
  // Every session leads BP3 with the Active Workflow block; a Lead adds its
  // orchestration and catalog slices (coding, agent mode or Mixy's).
  const workflowContext = packContext;
  const leadWorkflowParts = agentOwned
    ? undefined
    : leadPromptParts({ agentMode: sessionMode === AGENT_MODE, agentId: actingAgent });
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
    agent: agentOwned ? sessionProfile?.agent || 'worker' : homeAgent || 'lead',
    ...(homePermission ? { permission: homePermission } : {}),
    lane: agentOwned ? 'agent' : 'cli',
    // One-shot `mixdog exec` runs carry their own source so session catalogs
    // can keep them out of the user's resumable list.
    // A hidden run of an agent (Mixy's heartbeat) is an exec run too.
    sourceType: agentOwned
      ? sessionProfile?.sourceType || 'agent'
      : rt.toolProfile === HEADLESS_TOOL_PROFILE || sessionProfile?.sourceType === 'exec'
        ? 'exec'
        : 'lead',
    sourceName: agentOwned
      ? sessionProfile?.sourceName || sessionProfile?.agent || 'agent'
      : taskOrigin
        ? `agent:${taskOrigin.agentId}${taskOriginSuffix(taskOrigin)}`
        : clean(sessionProfile?.sourceName) || 'main',
    ...(taskOrigin ? { taskOrigin } : {}),
    // The agent a run acts for (agent mode, its memory; agent-mode.mjs).
    ...(!agentOwned && clean(sessionProfile?.ownerAgentId)
      ? { ownerAgentId: clean(sessionProfile.ownerAgentId) }
      : {}),
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
    ...(leadWorkflowParts ? { leadWorkflowParts } : {}),
    sessionMode,
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
