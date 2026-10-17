// Refresh the empty Lead session's model-facing tool surface and BP1/BP3
// layers after workflow or search/memory settings change. Conversation
// sessions keep their frozen schema; the next new session picks up the
// updated policy.
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
import { unusedModelEditToolName } from '../runtime/shared/edit-tool-dialect.mjs';

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

function rewriteBp3Core(session, nextCore) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const bp3 =
    messages.find((message) => message?.role === 'system' && message.cacheTier === 'tier3') ||
    messages.find(
      (message) =>
        message?.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith('# Active Workflow:')
    );
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

  async function refreshEmptySessionToolPolicy() {
    invalidatePreSessionToolSurface?.();
    const session = getSession?.();
    if (!session?.id) return { appliedToCurrentSession: true };
    if (!admitsRefresh(session)) return { appliedToCurrentSession: false };
    // Older records contain only compiled prompt text; rebuilding would guess
    // away custom instructions. Keep that immutable material for every owner.
    const identity = session.promptIdentity;
    if (!identity) return { appliedToCurrentSession: false, reason: 'missing-prompt-identity' };
    const ownerIsAgent = isAgentOwner(session);
    const schemaAllowedTools = honoredSchemaAllowlist(session.schemaAllowedTools, {
      ownerIsAgent,
      agent: identity.agent,
    });
    const toolFreeRole = ownerIsAgent && schemaAllowedTools?.length === 0;

    const {
      summary: workflow,
      context: leadWorkflowContext,
      packContext,
      orchestrationMode,
    } = activeWorkflowContext(getConfig(), getDataDir());
    const workflowContext = ownerIsAgent ? packContext : leadWorkflowContext;
    const denied = [
      ...session.callerDisallowedTools,
      ...featureDisallowedTools(),
      ...(workflow?.delegatesAgents === false ? ['agent'] : []),
    ]
      .map((name) => String(name || ''))
      .filter(Boolean);

    // Stage: everything below is computed without touching the session, so a
    // turn that starts during the async rebuild cannot lose tools to it.
    const baseRules =
      identity.skipAgentRules || toolFreeRole
        ? ''
        : _buildBaseRules({
            omitTools: [...denied, unusedModelEditToolName(getRoute()?.model)],
            allowTools: schemaAllowedTools,
            provider: getRoute()?.provider,
            model: getRoute()?.model,
          });
    const coreMemoryContext = await leadCoreMemoryContext();
    const { sessionMarkerCore } = composeSystemPrompt({
      ...sessionRolePromptFields(identity, {
        ownerIsAgent,
        toolFreeRole,
        delegationFree: delegationDisabled(session, ownerIsAgent),
      }),
      provider: getRoute()?.provider,
      workflowContext,
      coreMemoryContext,
      // The rebuilt core keeps (or newly applies) the instruction-files setting.
      instructionFilesContext: toolFreeRole ? null : loadInstructionFilesContext?.(session) || null,
    });
    // Apply: re-check admission after the await, then mutate synchronously.
    if (!admitsRefresh(session)) return { appliedToCurrentSession: false };
    session.workflow = toSessionWorkflowMeta(workflow);
    session.orchestrationMode = orchestrationMode;
    applyToolDenials(session, denied, schemaAllowedTools, ownerIsAgent);
    rewriteSystemHeading(session, '# Tool Use', baseRules);
    rewriteBp3Core(session, sessionMarkerCore);
    session.updatedAt = Date.now();
    return { appliedToCurrentSession: true };
  }

  return { refreshEmptySessionToolPolicy };
}
