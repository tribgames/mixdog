// Refresh the empty Lead session's model-facing tool surface and BP1/BP3
// layers after workflow or search/memory settings change. Conversation
// sessions keep their frozen schema; the next new session picks up the
// updated policy. The one exception is a workflow switch made in the session
// itself (switchSessionWorkflow), which rebuilds that conversation's policy.
import { sessionHasConversationMessages } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { toSessionWorkflowMeta } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import {
  applyDeferredToolSurface,
  filterDisallowedTools,
} from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { deferredSurfaceModeForLead } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';
import {
  applyInitialDeferredToolManifestToBp2,
  composeSystemPrompt,
} from '../runtime/agent/orchestrator/context/collect.mjs';
import { _buildBaseRules } from '../runtime/agent/orchestrator/session/manager/rules-cache.mjs';
import { sessionRolePromptFields } from '../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import {
  delegationDisabled,
  honoredSchemaAllowlist,
} from '../runtime/agent/orchestrator/session/manager/session-tool-surface.mjs';
import { finalizeSessionToolList } from '../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';
import {
  AGENT_MODE,
  isRoutineSource,
  resolveSessionMode,
  sessionModeOf,
} from '../runtime/agent/orchestrator/session/agent-mode.mjs';
import { unusedModelEditToolName } from '../runtime/shared/edit-tool-dialect.mjs';
import { MIXY_AGENT_ID } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import {
  refreshSessionBp3Environment,
  withPresentedWorkspaceSlices,
} from '../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { stageWorkflowSwitchNotice } from '../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { markToolSurfaceMigrated } from '../runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs';
import { agentProfileRevision, leadRosterRevision } from '../runtime/agent/orchestrator/context/role-instructions.mjs';
import { recordTranscriptBoundary } from './model-route/set-route.mjs';

const WORKFLOW_SWITCH_BUSY = 'The session is running a turn; wait for it to finish.';
const AGENT_PROFILE_INTENT = 'agent_profile';

function toolNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter(Boolean);
}

function replaceMessageContent(messages, target, content) {
  const index = messages.indexOf(target);
  if (index < 0) return false;
  messages[index] = { ...target, content };
  return true;
}

function rewriteSystemHeading(session, heading, nextContent) {
  if (!nextContent) return;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const target = messages.find(
    (message) =>
      message?.role === 'system' && typeof message.content === 'string' && message.content.startsWith(heading)
  );
  if (target) replaceMessageContent(messages, target, nextContent);
}

function bp3Message(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return (
    messages.find((message) => message?.role === 'system' && message.cacheTier === 'tier3') ||
    messages.find(
      (message) =>
        message?.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith('# Active Workflow:')
    )
  );
}

// The BP3 core the session's prompt carries now (split layout: the whole
// tier3 block; combined: the stored core beside the environment).
function presentedBp3Core(session) {
  return session.bp3EnvSplit === true ? bp3Message(session)?.content : session.bp3CoreContext;
}

function rewriteBp3Core(session, nextCore) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const bp3 = bp3Message(session);
  if (!bp3 || typeof bp3.content !== 'string') return;
  if (session.bp3EnvSplit === true) {
    // Split layout: the environment lives in its own cacheTier:'env' system
    // block — the tier3 block carries the core only.
    replaceMessageContent(messages, bp3, nextCore || '');
    session.bp3CoreContext = nextCore || '';
    return;
  }
  const env = session.bp3EnvironmentContext || '';
  replaceMessageContent(messages, bp3, [nextCore, env].filter((part) => String(part || '').trim()).join('\n\n---\n\n'));
  session.bp3CoreContext = nextCore || '';
}

// A Lead's workflow slices (orchestration, agent and contact catalogs) for its
// mode, Mixy's with the contacts.
function leadPartsFor(session, leadPromptParts) {
  return leadPromptParts({
    agentMode: sessionModeOf(session) === AGENT_MODE,
    mixy: resolveSessionMode({ session }).agentId === MIXY_AGENT_ID,
  });
}

// A conversation keeps its `# Session` block: the legacy combined layout
// rebuilds the tier3 block from the new core (rooted where it was).
function rewriteConversationBp3Core(session, nextCore) {
  if (session.bp3EnvSplit !== true && typeof session.bp3CoreContext === 'string') {
    const previous = session.bp3CoreContext;
    session.bp3CoreContext = nextCore;
    if (refreshSessionBp3Environment(session, session.cwd)) return;
    session.bp3CoreContext = previous;
  }
  rewriteBp3Core(session, nextCore);
}

export function createToolPolicyRefresh({
  getSession,
  getRoute,
  getMode,
  getConfig,
  getDataDir,
  getActiveTurnCount,
  modelStandaloneTools,
  featureDisallowedTools,
  loadCoreMemoryContext,
  loadInstructionFilesContext,
  activeWorkflowContext,
  invalidatePreSessionToolSurface,
}) {
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

  // A turn is executing from the moment it opens until it settles, even when
  // its transcript holds only notifications (which are not conversation
  // content). Its tool surface is frozen for that whole span.
  function turnInFlight(session) {
    return (getActiveTurnCount?.() || 0) > 0 || Array.isArray(session.liveTurnMessages);
  }

  // Admission: the session is still the current one, no turn is executing and
  // no conversation has started. Checked before staging and again right
  // before the staged change is applied.
  function admitsRefresh(session) {
    return (
      getSession?.() === session &&
      !turnInFlight(session) &&
      !sessionHasConversationMessages(session) &&
      !sessionHasConversationMessages({ messages: session.liveTurnMessages })
    );
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
    const leadWorkflowParts = ownerIsAgent ? {} : leadPartsFor(session, leadPromptParts);
    const denied = [
      ...session.callerDisallowedTools,
      ...featureDisallowedTools(),
      ...(workflow?.delegatesAgents === false ? ['agent'] : []),
    ]
      .map((name) => String(name || ''))
      .filter(Boolean);

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
    const { sessionMarkerCore } = composeSystemPrompt({
      ...sessionRolePromptFields(identity, {
        ownerIsAgent,
        toolFreeRole,
        delegationFree: delegationDisabled(session, ownerIsAgent),
        sessionMode,
        routine: isRoutineSource(session.sourceType),
      }),
      provider: getRoute()?.provider,
      workflowContext,
      ...leadWorkflowParts,
      coreMemoryContext,
      // The rebuilt core keeps (or newly applies) the instruction-files
      // setting; agent mode carries none.
      instructionFilesContext:
        conversation || toolFreeRole || agentMode ? null : loadInstructionFilesContext?.(session) || null,
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
    };
  }

  // Apply a staged policy synchronously; the BP3 core is the caller's.
  function applyPolicy(session, staged) {
    session.workflow = toSessionWorkflowMeta(staged.workflow);
    session.orchestrationMode = staged.orchestrationMode;
    session.sessionMode = staged.sessionMode;
    applyToolDenials(session, staged.denied, staged.schemaAllowedTools, staged.ownerIsAgent);
    rewriteSystemHeading(session, '# Tool Use', staged.baseRules);
    session.updatedAt = Date.now();
  }

  async function refreshEmptySessionToolPolicy() {
    invalidatePreSessionToolSurface?.();
    const session = getSession?.();
    if (!session?.id) return { appliedToCurrentSession: true };
    if (!admitsRefresh(session)) return { appliedToCurrentSession: false };
    // Older records contain only compiled prompt text; rebuilding would guess
    // away custom instructions. Keep that immutable material for every owner.
    const identity = session.promptIdentity;
    if (!identity) return { appliedToCurrentSession: false, reason: 'missing-prompt-identity' };
    const staged = await stagePolicy(session, identity, getConfig());
    // Apply: re-check admission after the await, then mutate synchronously.
    if (!admitsRefresh(session)) return { appliedToCurrentSession: false };
    applyPolicy(session, staged);
    rewriteBp3Core(session, staged.core);
    return { appliedToCurrentSession: true };
  }

  /**
   * Switch the current coding session's workflow mid-conversation (the
   * composer's workflow selector): its prompt (BP3 core and `# Tool Use`) and
   * tool/delegation surface are rebuilt now for `workflowId` with the current
   * orchestration mode and agents, so its next turn runs on them, and that
   * turn carries a one-time notice (manager/workflow-switch-notice.mjs). The
   * provider prompt cache is rebuilt once. Refused while a turn runs, like a
   * working-folder change. The configured workflow (the default for new
   * sessions) is the caller's and stays as it is.
   *
   * Running work is untouched: agents and workers the session started under
   * the old workflow are separate sessions with their own prompts and tools,
   * so they keep running as they are (unlike a working-folder change, running
   * agents never refuse this); only delegation made from the next turn on
   * uses the new surface.
   *
   * Returns null when the session has no conversation (the caller applies the
   * configured workflow to an empty session as before), else
   * `{ appliedToCurrentSession: true, workflow, workflowSwitch }` where
   * `workflowSwitch` is the transcript boundary (null when unchanged).
   */
  async function switchSessionWorkflow(workflowId) {
    const session = getSession?.();
    if (!session?.id) return null;
    const conversation = () =>
      sessionHasConversationMessages(session) || sessionHasConversationMessages({ messages: session.liveTurnMessages });
    if (!conversation()) return null;
    if (isAgentOwner(session) || sessionModeOf(session) === AGENT_MODE) {
      throw new Error('Only a coding session has a workflow.');
    }
    const identity = session.promptIdentity;
    if (!identity) throw new Error('This session is too old to switch its workflow; start a new task.');
    const busy = () => getSession?.() !== session || turnInFlight(session);
    if (busy()) throw new Error(WORKFLOW_SWITCH_BUSY);
    const config = getConfig();
    const staged = await stagePolicy(
      session,
      identity,
      { ...config, workflow: { ...(config?.workflow || {}), active: workflowId } },
      { conversation: true }
    );
    if (busy()) throw new Error(WORKFLOW_SWITCH_BUSY);
    const before = session.workflow;
    const from = before?.id ? before : null;
    applyPolicy(session, staged);
    rewriteConversationBp3Core(session, staged.core);
    // The request prefix changed: drop provider replay state and the context
    // baseline, and tag the next send's expected cache break.
    markToolSurfaceMigrated(session, 'workflow_switch');
    stageWorkflowSwitchNotice(session, from, session.workflow);
    let workflowSwitch = null;
    if (from?.id !== session.workflow.id) {
      workflowSwitch = {
        fromId: from?.id || '',
        from: from?.name || from?.id || '',
        toId: session.workflow.id,
        to: session.workflow.name,
        at: Date.now(),
      };
      recordTranscriptBoundary(session, 'workflowSwitches', workflowSwitch, (entry) => entry?.at === workflowSwitch.at);
    }
    return { appliedToCurrentSession: true, workflow: session.workflow, workflowSwitch };
  }

  // An agent profile edit that met a running turn: the next turn applies it.
  let agentProfilePending = false;

  /**
   * Bring a Lead session's prompt to the saved bots — its own agent's
   * persona, AGENT.md and name, and the bot roster its catalogs list — after
   * a bot was saved, created, renamed, archived or restored
   * (agent-profile-changes.mjs), on resume, or at the start of the turn after
   * one that ran through the change (`trigger`: 'save' | 'resume' | 'turn').
   * Two stamps (agentProfileRevision, agentRosterRevision) tell whether
   * anything it embeds changed; a delegated worker keeps its prompt. The core
   * is rebuilt like a workflow switch's (the session's own workflow, the
   * workspace slices the model was told) and replaces the stored one, so the
   * next turn sends it with one provider cache break; nothing is re-read per
   * turn. Tools are untouched. Returns true when the prompt changed.
   */
  async function refreshAgentProfile({ trigger = 'save' } = {}) {
    const session = getSession?.();
    const identity = session?.promptIdentity;
    const agent = identity?.agent;
    if (!session?.id || !agent || isAgentOwner(session)) return false;
    // Only Mixy's own (agent-mode) thread embeds Mixy's profile.
    const revision = agentProfileRevision(agent, { mixy: sessionModeOf(session) === AGENT_MODE });
    const config = getConfig();
    const workflowId = session.workflow?.id;
    const workflowConfig = workflowId
      ? { ...config, workflow: { ...(config?.workflow || {}), active: workflowId } }
      : config;
    const roster = leadRosterRevision(
      leadPartsFor(session, activeWorkflowContext(workflowConfig, getDataDir()).leadPromptParts)
    );
    if (session.agentProfileRevision === revision && session.agentRosterRevision === roster) return false;
    // A coding session from before profile stamps keeps its prompt when it
    // is reopened; a saved edit still reaches it.
    if (session.agentProfileRevision === undefined && trigger === 'resume' && sessionModeOf(session) !== AGENT_MODE) {
      return false;
    }
    // At a turn's start its own turn is the one counted; nothing runs yet.
    const busy = () => getSession?.() !== session || (trigger !== 'turn' && turnInFlight(session));
    if (busy()) {
      agentProfilePending = true;
      return false;
    }
    const staged = await stagePolicy(session, identity, workflowConfig, { conversation: true });
    if (busy()) {
      agentProfilePending = true;
      return false;
    }
    session.agentProfileRevision = revision;
    session.agentRosterRevision = roster;
    session.updatedAt = Date.now();
    if (staged.core === presentedBp3Core(session)) return false;
    rewriteConversationBp3Core(session, staged.core);
    // The request prefix changed: one cache break, tagged on the next send.
    markToolSurfaceMigrated(session, AGENT_PROFILE_INTENT);
    return true;
  }

  /** Turn start: apply an edit that arrived while the previous turn ran. */
  async function applyPendingAgentProfile() {
    if (!agentProfilePending) return false;
    agentProfilePending = false;
    return refreshAgentProfile({ trigger: 'turn' });
  }

  return { refreshEmptySessionToolPolicy, switchSessionWorkflow, refreshAgentProfile, applyPendingAgentProfile };
}
