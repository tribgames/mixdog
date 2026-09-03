// Refresh the empty Lead session's model-facing tool surface and BP1/BP3
// layers after workflow or search/memory settings change. Conversation
// sessions keep their frozen schema; the next new session picks up the
// updated policy.
import { sessionHasConversationMessages } from './session-text.mjs';
import { toSessionWorkflowMeta } from './workflow.mjs';
import { applyDeferredToolSurface, filterDisallowedTools } from './tool-catalog.mjs';
import { deferredSurfaceModeForLead } from './effort.mjs';
import { applyInitialDeferredToolManifestToBp2, composeSystemPrompt } from '../runtime/agent/orchestrator/context/collect.mjs';
import { _buildSharedRules, _buildLeadRules, _buildLeadLanguageContext } from '../runtime/agent/orchestrator/session/manager/rules-cache.mjs';
import { unusedModelEditToolName } from '../runtime/shared/edit-tool-dialect.mjs';

function toolNames(list) {
  return (Array.isArray(list) ? list : []).map((item) => (
    typeof item === 'string' ? item : item?.name
  )).filter(Boolean);
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
  const target = messages.find((message) => (
    message?.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(heading)
  ));
  if (target) replaceMessageContent(messages, target, nextContent);
}

function rewriteBp3Core(session, nextCore) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const bp3 = messages.find((message) => message?.role === 'system' && message.cacheTier === 'tier3')
    || messages.find((message) => (
      message?.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('# Active Workflow:')
    ));
  if (!bp3 || typeof bp3.content !== 'string') return;
  if (session.bp3EnvSplit === true) {
    // Split layout: the environment lives in its own cacheTier:'env' system
    // block — the tier3 block carries the core only.
    replaceMessageContent(messages, bp3, nextCore || '');
    session.bp3CoreContext = nextCore || '';
    return;
  }
  const env = session.bp3EnvironmentContext || '';
  replaceMessageContent(
    messages,
    bp3,
    [nextCore, env].filter((part) => String(part || '').trim()).join('\n\n---\n\n'),
  );
  session.bp3CoreContext = nextCore || '';
}

export function createToolPolicyRefresh({
  getSession,
  getRoute,
  getMode,
  getConfig,
  getDataDir,
  modelStandaloneTools,
  featureDisallowedTools,
  memoryToolsEnabled,
  loadCoreMemoryContext,
  activeWorkflowContext,
  invalidatePreSessionToolSurface,
}) {
  async function refreshEmptySessionToolPolicy() {
    invalidatePreSessionToolSurface?.();
    const session = getSession?.();
    if (!session?.id) return { appliedToCurrentSession: true };
    if (sessionHasConversationMessages(session)
      || sessionHasConversationMessages({ messages: session.liveTurnMessages })) {
      return { appliedToCurrentSession: false };
    }

    const { summary: workflow, context: workflowContext } = activeWorkflowContext(getConfig(), getDataDir());
    const denied = [
      ...featureDisallowedTools(),
      ...(workflow?.delegatesAgents === false ? ['agent'] : []),
    ].map((name) => String(name || '')).filter(Boolean);
    session.workflow = toSessionWorkflowMeta(workflow);
    session.disallowedTools = denied;
    session.tools = filterDisallowedTools(session.tools, denied);
    if (Array.isArray(session.deferredToolCatalog)) {
      session.deferredToolCatalog = filterDisallowedTools(session.deferredToolCatalog, denied);
    }
    applyDeferredToolSurface(
      session,
      deferredSurfaceModeForLead(getMode()),
      modelStandaloneTools(),
      { provider: getRoute()?.provider },
    );
    const catalog = Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : [];
    const active = new Set(toolNames(session.tools).concat(toolNames(session.deferredCallableTools)));
    const pool = catalog.map((tool) => String(tool?.name || '')).filter((name) => name && !active.has(name));
    applyInitialDeferredToolManifestToBp2(session, pool, { rebuild: true });

    const allowsAgents = workflow?.delegatesAgents !== false;
    const baseRules = _buildSharedRules({
      omitTools: [...denied, unusedModelEditToolName(getRoute()?.model)],
    });
    const roleRules = _buildLeadRules({ includeLeadBrief: allowsAgents });
    let coreMemoryContext = '';
    if (memoryToolsEnabled()) {
      try { coreMemoryContext = await loadCoreMemoryContext(); }
      catch { coreMemoryContext = ''; }
    }
    const { sessionMarkerCore } = composeSystemPrompt({
      roleRules,
      skipRoleCatalog: true,
      workflowContext,
      coreMemoryContext,
      // BP3 rebuild must keep the trailing language block, or a workflow
      // switch would silently drop the response-language directive.
      languageContext: _buildLeadLanguageContext(),
    });
    rewriteSystemHeading(session, '# Tool Use', baseRules);
    rewriteBp3Core(session, sessionMarkerCore);
    session.updatedAt = Date.now();
    return { appliedToCurrentSession: true };
  }

  return { refreshEmptySessionToolPolicy };
}
