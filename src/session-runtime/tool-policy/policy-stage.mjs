// Staging and applying the tool/prompt policy a config gives a Lead session:
// the tools it is denied, its BP1 rules and its BP3 core.
import {
  toSessionWorkflowMeta,
  workflowDisallowsAgentTool,
} from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import {
  applyDeferredToolSurface,
  filterDisallowedTools,
} from '../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { deferredSurfaceModeForLead } from '../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import {
  applyInitialDeferredToolManifestToBp2,
  buildSkillManifest,
  collectPromptSkillsCached,
  composeSystemPrompt,
} from '../../runtime/agent/orchestrator/context/collect.mjs';
import {
  _buildBaseRules,
  _buildLeadMetaContext,
} from '../../runtime/agent/orchestrator/session/manager/rules-cache.mjs';
import { sessionRolePromptFields } from '../../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import {
  delegationDisabled,
  honoredSchemaAllowlist,
  reactionDisabled,
} from '../../runtime/agent/orchestrator/session/manager/session-tool-surface.mjs';
import { REACTION_TOOL_NAME } from '../../runtime/agent/orchestrator/runtime-core/reaction-tool-defs.mjs';
import { finalizeSessionToolList } from '../../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { AGENT_MODE, sessionModeOf } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { unusedModelEditToolName } from '../../runtime/shared/edit-tool-dialect.mjs';
import {
  presentedAgentCatalogSlice,
  withPresentedWorkspaceSlices,
} from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { leadPartsFor, rewriteSystemHeading, toolNames } from './surface-helpers.mjs';

export function createPolicyStage({
  getRoute,
  getMode,
  getDataDir,
  modelStandaloneTools,
  featureDisallowedTools,
  loadCoreMemoryContext,
  loadInstructionFilesContext,
  activeWorkflowContext,
}) {
  // The tools `session` is denied now: its caller's denials, the feature gates
  // as they stand, an agent-mode Lead's agent tool when its workflow
  // delegates to no one (a coding Lead keeps it: workflow.mjs
  // workflowDisallowsAgentTool), and react outside a bot's chat with the user.
  function liveDeniedTools(session, workflow) {
    return [
      ...session.callerDisallowedTools,
      ...featureDisallowedTools(),
      ...(workflowDisallowsAgentTool(workflow, { agentMode: sessionModeOf(session) === AGENT_MODE }) ? ['agent'] : []),
      ...(reactionDisabled(session, isAgentOwner(session)) ? [REACTION_TOOL_NAME] : []),
    ]
      .map((name) => String(name || ''))
      .filter(Boolean);
  }

  // Denied tools leave every surface, then the deferred surface is rebuilt
  // for the lead's current mode.
  function applyToolDenials(session, denied, schemaAllowedTools, ownerIsAgent) {
    session.disallowedTools = denied;
    session.tools = filterDisallowedTools(session.tools, denied);
    if (Array.isArray(session.deferredToolCatalog)) {
      session.deferredToolCatalog = filterDisallowedTools(session.deferredToolCatalog, denied);
    }
    const catalogTools = finalizeSessionToolList(modelStandaloneTools(), {
      schemaAllowedTools,
      disallowedTools: denied,
      ownerIsAgent,
    });
    session.tools = finalizeSessionToolList(session.tools, {
      schemaAllowedTools,
      disallowedTools: denied,
      ownerIsAgent,
    });
    applyDeferredToolSurface(session, deferredSurfaceModeForLead(getMode()), catalogTools, {
      provider: getRoute()?.provider,
    });
    const catalog = Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : [];
    const active = new Set(toolNames(session.tools).concat(toolNames(session.deferredCallableTools)));
    const pool = catalog.map((tool) => String(tool?.name || '')).filter((name) => name && !active.has(name));
    applyInitialDeferredToolManifestToBp2(session, pool, { rebuild: true });
  }

  async function leadCoreMemoryContext() {
    try {
      return await loadCoreMemoryContext();
    } catch {
      return '';
    }
  }

  // The policy `config` gives `session`, computed without touching the
  // session, so a turn that starts during the async rebuild cannot lose tools
  // to it. `conversation`: the rebuilt BP3 core keeps the instruction files
  // and core memory the prompt presents now (withPresentedWorkspaceSlices).
  async function stagePolicy(session, identity, config, { conversation = false } = {}) {
    const ownerIsAgent = isAgentOwner(session);
    const schemaAllowedTools = honoredSchemaAllowlist(session.schemaAllowedTools, {
      ownerIsAgent,
      agent: identity.agent,
    });
    const toolFreeRole = ownerIsAgent && schemaAllowedTools?.length === 0;

    const {
      summary: workflow,
      leadPromptParts,
      packContext: workflowContext,
      orchestrationMode,
    } = activeWorkflowContext(config, getDataDir());
    const sessionMode = sessionModeOf(session);
    const agentMode = sessionMode === AGENT_MODE;
    // A coding Lead's conversation keeps the agent list it was built with, as
    // it keeps the workspace slices: agents switched on or off since reach it
    // as reminders on top of that list (agent-listing-notice.mjs). A slice
    // that is not one generated list is rebuilt as before.
    const presentedCatalog = conversation && !agentMode ? presentedAgentCatalogSlice(session) : null;
    const leadWorkflowParts = ownerIsAgent
      ? {}
      : {
          ...leadPartsFor(session, leadPromptParts),
          ...(presentedCatalog !== null ? { agentCatalogContext: presentedCatalog } : {}),
        };
    const denied = liveDeniedTools(session, workflow);

    const baseRules =
      identity.skipAgentRules || toolFreeRole
        ? ''
        : _buildBaseRules({
            omitTools: [...denied, unusedModelEditToolName(getRoute()?.model)],
            allowTools: schemaAllowedTools,
            provider: getRoute()?.provider,
            model: getRoute()?.model,
          });
    const coreMemoryContext = conversation ? '' : await leadCoreMemoryContext();
    // BP2's stable part as session creation composes it
    // (session-prompt-composition.mjs): the Lead meta context and the skill
    // manifest of the skills in scope now.
    const skipRules = identity.skipAgentRules || toolFreeRole;
    const skills = schemaAllowedTools?.length === 0 ? [] : collectPromptSkillsCached(session.cwd);
    const { sessionMarkerCore, stableSystemContext } = composeSystemPrompt({
      ...sessionRolePromptFields(identity, {
        ownerIsAgent,
        toolFreeRole,
        delegationFree: delegationDisabled(session, ownerIsAgent),
        sessionMode,
      }),
      provider: getRoute()?.provider,
      workflowContext,
      ...leadWorkflowParts,
      coreMemoryContext,
      // The rebuilt core keeps (or newly applies) the instruction-files
      // setting; agent mode carries none.
      instructionFilesContext:
        conversation || toolFreeRole || agentMode ? null : loadInstructionFilesContext?.(session) || null,
      metaContext: skipRules || ownerIsAgent ? undefined : _buildLeadMetaContext({ includeOutputStyle: !agentMode }),
      skillManifest: buildSkillManifest(skills),
    });
    return {
      workflow,
      orchestrationMode,
      sessionMode,
      denied,
      schemaAllowedTools,
      ownerIsAgent,
      baseRules,
      core: conversation ? withPresentedWorkspaceSlices(session, sessionMarkerCore) : sessionMarkerCore,
      // Without BP1 the BP2 block cannot be located: null leaves it as it is.
      stableContext: skipRules ? null : stableSystemContext,
    };
  }

  // Apply a staged policy synchronously; the BP3 core is the caller's. The
  // prompt then carries the session's workflow and tools as they stand.
  function applyPolicy(session, staged) {
    delete session.workflowOverlay;
    delete session.orchestrationModeOverlay;
    delete session.workflowOpenedTools;
    delete session.promptFoldPending;
    session.workflow = toSessionWorkflowMeta(staged.workflow);
    session.orchestrationMode = staged.orchestrationMode;
    session.sessionMode = staged.sessionMode;
    applyToolDenials(session, staged.denied, staged.schemaAllowedTools, staged.ownerIsAgent);
    // BP1 opens with its first rule file's heading (`# Tool Calls`); older
    // prompts opened with `# Tool Use`.
    const heading = String(staged.baseRules || '').split('\n', 1)[0];
    for (const candidate of new Set(['# Tool Use', heading].filter(Boolean))) {
      rewriteSystemHeading(session, candidate, staged.baseRules);
    }
    session.updatedAt = Date.now();
  }

  return { liveDeniedTools, stagePolicy, applyPolicy };
}
