// manager/session-tool-surface.mjs
// Which tools a session routes, which of them the provider actually sees, and
// which names BP1 must therefore omit — for a session being created and for a
// stored session being resumed/rerouted. Both paths apply the SAME deny rules
// (caller disallowedTools + delegation) and the same caller allowlist, so they
// live together: a rule added to one and not the other is exactly the leak
// these functions exist to prevent.
import { collectPromptSkillsCached } from '../../context/collect.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { getHiddenAgent } from '../../internal-agents.mjs';
import { workflowDisallowsAgentTool } from '../../../../../session-runtime/workflow.mjs';
import { sessionOrchestrationMode } from '../../../../shared/orchestration.mjs';
import { finalizeSessionToolList, resolveSessionTools, permissionFromToolSpec } from './tool-resolution.mjs';
import { unusedModelEditToolName } from '../../../../shared/edit-tool-dialect.mjs';
import { getAgentRuntimeSync } from './agent-runtime-singleton.mjs';

// A lead session may not delegate when orchestration is off or its workflow
// forbids the agent tool; an agent-owned session never gets the tool anyway.
export function delegationDisabled(source, ownerIsAgent) {
  return !ownerIsAgent && (sessionOrchestrationMode(source) === 'none' || workflowDisallowsAgentTool(source?.workflow));
}

// Exactly two schema surfaces exist: Lead and Agent. Every Agent role gets
// the full Lead-capable base bundle; the recursive `agent` control tool is
// removed later at the owner boundary. Role permission remains prompt/
// diagnostic metadata and does not fragment the provider-visible schema.
function resolveToolSpec(toolPreset, profile, ownerIsAgent) {
  if (ownerIsAgent) return 'full';
  return Array.isArray(profile?.tools) ? profile.tools : toolPreset;
}

// Every tool omitted by a caller schema allowlist is omitted from BP1 too.
// The model never receives guidance for a tool it cannot call, and a new
// process-wide built-in cannot leak into a narrow profile's prompt.
function schemaOmittedToolNames(toolsForRouting, tools) {
  const visibleToolNames = new Set(tools.map((tool) => String(tool?.name || '').toLowerCase()));
  return toolsForRouting
    .map((tool) => String(tool?.name || ''))
    .filter((name) => name && !visibleToolNames.has(name.toLowerCase()));
}

// Role-resolved tool inventory: the routed list, the provider-visible list
// after the caller allow/deny lists, and the names BP1 must omit.
// BP1 is shared tool policy. BP2 holds persistent profile/tool catalogs;
// BP3 holds workflow/role and session/project environment.
export function resolveSessionToolSurface(opts, { profile, toolPreset, modelName }) {
  const ownerIsAgent = isAgentOwner(opts.owner);
  const resolvedAgent = opts.agent || opts.role || profile?.taskType || null;
  const hiddenAgent = getHiddenAgent(resolvedAgent);
  const isRetrievalAgent = hiddenAgent?.kind === 'retrieval';
  // Lead and Agent share the same cwd-scoped Skill inventory.
  const skills = opts.skipSkills ? [] : collectPromptSkillsCached(opts.cwd);
  // BP1 shared tool policy ships to EVERY role (Lead, workers, retrieval,
  // maintenance): its anti-spiral clauses (one anchor is enough, never
  // repeat equivalent patterns/scopes, plausible hit → stop) are exactly
  // what narrow retrieval roles need. Role docs
  // override role-inapplicable entries.
  const sessionDeny = [
    ...(Array.isArray(opts.disallowedTools) ? opts.disallowedTools : []),
    ...(delegationDisabled(opts, ownerIsAgent) ? ['agent'] : []),
  ];
  // Role permission is prompt/diagnostic metadata only. Resolve and persist
  // it without shaping the provider-visible Agent schema.
  const toolPermission = opts.permission || profile?.permission || permissionFromToolSpec(toolPreset) || null;
  const toolSpec = resolveToolSpec(toolPreset, profile, ownerIsAgent);
  const toolsForRouting = resolveSessionTools(toolSpec, skills, {
    ownerIsAgentSession: ownerIsAgent,
    mcpScopeId: opts.mcpScopeId || null,
    modelName,
    cwd: opts.cwd || null,
  });

  const hasCallerAllow = Array.isArray(opts.schemaAllowedTools);
  const schemaAllowedTools = ownerIsAgent || !hasCallerAllow ? null : opts.schemaAllowedTools;
  const tools = finalizeSessionToolList(toolsForRouting, {
    schemaAllowedTools,
    disallowedTools: sessionDeny,
    ownerIsAgent,
  });
  const schemaOmittedTools = hasCallerAllow ? schemaOmittedToolNames(toolsForRouting, tools) : [];
  return {
    ownerIsAgent,
    resolvedAgent,
    agentRulesProfile: isRetrievalAgent ? 'retrieval' : 'full',
    skills,
    sessionDeny,
    toolPermission,
    toolSpec,
    toolsForRouting,
    tools,
    hasCallerAllow,
    schemaAllowedTools,
    ruleOmitTools: [...sessionDeny, ...schemaOmittedTools, unusedModelEditToolName(modelName)],
  };
}

// The same surface for a session that already exists: the stored record
// supplies what `opts` supplies on create (owner, cwd, profile, allow/deny).
export function _prepareResumeTools(session, preset) {
  const ownerIsAgent = isAgentOwner(session);
  const skills = collectPromptSkillsCached(session.cwd);
  let toolSpec = ownerIsAgent ? 'full' : preset || session.preset || 'full';
  const agentRuntime = getAgentRuntimeSync();
  if (session.profileId && agentRuntime?.getProfile) {
    try {
      const profile = agentRuntime.getProfile(session.profileId);
      if (!ownerIsAgent && Array.isArray(profile?.tools)) toolSpec = profile.tools;
    } catch {
      /* ignore lookup failures, keep preset fallback */
    }
  }
  const toolsForRouting = resolveSessionTools(toolSpec, skills, {
    ownerIsAgentSession: ownerIsAgent,
    mcpScopeId: session.mcpScopeId || null,
    modelName: session.model,
    cwd: session.cwd || null,
  });
  return {
    session,
    preset,
    toolSpec,
    ownerIsAgent,
    tools: finalizeSessionToolList(toolsForRouting, {
      schemaAllowedTools:
        !ownerIsAgent && Array.isArray(session.schemaAllowedTools) ? session.schemaAllowedTools : null,
      disallowedTools: [
        ...(Array.isArray(session.disallowedTools) ? session.disallowedTools : []),
        ...(delegationDisabled(session, ownerIsAgent) ? ['agent'] : []),
      ],
      ownerIsAgent,
    }),
  };
}
