// Pure helpers of the tool-policy refresh: reading a session's tool surface,
// rewriting its system blocks (BP1 heading, BP3 core), and the configs a
// session's workflow and orchestration mode give.
import { AGENT_MODE, resolveSessionMode, sessionModeOf } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { MIXY_AGENT_ID } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { refreshSessionBp3Environment } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { promptOrchestrationModeOf } from '../../runtime/agent/orchestrator/session/manager/orchestration-mode-switch-notice.mjs';
import { sessionOrchestrationMode } from '../../runtime/shared/orchestration.mjs';

export const toolName = (tool) => String(tool?.name || '');

// Every tool definition the session's schema or deferred catalogs hold.
export function schemaTools(session) {
  return [
    ...(Array.isArray(session.tools) ? session.tools : []),
    ...(Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []),
    ...(Array.isArray(session.deferredLateToolCatalog) ? session.deferredLateToolCatalog : []),
  ];
}

export function toolNames(list) {
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

export function rewriteSystemHeading(session, heading, nextContent) {
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
export function presentedBp3Core(session) {
  return session.bp3EnvSplit === true ? bp3Message(session)?.content : session.bp3CoreContext;
}

export function rewriteBp3Core(session, nextCore) {
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
export function leadPartsFor(session, leadPromptParts) {
  return leadPromptParts({
    agentMode: sessionModeOf(session) === AGENT_MODE,
    mixy: resolveSessionMode({ session }).agentId === MIXY_AGENT_ID,
  });
}

// A conversation keeps its `# Session` block: the legacy combined layout
// rebuilds the tier3 block from the new core (rooted where it was).
export function rewriteConversationBp3Core(session, nextCore) {
  if (session.bp3EnvSplit !== true && typeof session.bp3CoreContext === 'string') {
    const previous = session.bp3CoreContext;
    session.bp3CoreContext = nextCore;
    if (refreshSessionBp3Environment(session, session.cwd)) return;
    session.bp3CoreContext = previous;
  }
  rewriteBp3Core(session, nextCore);
}

// `config` with `workflowId` as the active workflow (itself when absent).
export function configForWorkflow(config, workflowId) {
  return workflowId ? { ...config, workflow: { ...(config?.workflow || {}), active: workflowId } } : config;
}

// A conversation's config: its workflow and its own orchestration mode
// (`mode`), never the configured default for new sessions.
export function configForSession(config, workflowId, mode) {
  return { ...configForWorkflow(config, workflowId), orchestrationMode: mode };
}

// The session's orchestration mode now (a legacy record derives it).
export const currentMode = (session) => sessionOrchestrationMode(session);
// The mode its prompt was built with.
export const promptMode = (session) => promptOrchestrationModeOf(session) ?? currentMode(session);
