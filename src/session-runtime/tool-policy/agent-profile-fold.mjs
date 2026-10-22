// Bringing a Lead session's prompt to the saved bots and folding pending prompt
// changes (a switched workflow or mode, moved tool gates, changed shipped
// rules) in where the provider cache is cold anyway.
import { sessionHasConversationMessages } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { orchestrationModeFromPrompt } from '../../runtime/agent/orchestrator/session/manager/orchestration-mode-switch-notice.mjs';
import { promptRulesRevision } from '../../runtime/agent/orchestrator/session/manager/rules-cache.mjs';
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { AGENT_MODE, sessionModeOf } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import {
  conversationHolds,
  promptWorkflowOf,
} from '../../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { sessionTailCacheExpired } from '../../runtime/agent/orchestrator/agent-runtime/cache-strategy.mjs';
import { mergePendingDeferredToolDelta } from '../../runtime/agent/orchestrator/runtime-core/deferred-tool-delta.mjs';
import {
  agentMcpToolPermission,
  connectorPolicyAgentOf,
} from '../../runtime/agent/orchestrator/mcp/agent-connectors.mjs';
import { markToolSurfaceMigrated } from '../../runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs';
import {
  agentProfileRevision,
  leadRosterRevision,
} from '../../runtime/agent/orchestrator/context/role-instructions.mjs';
import {
  configForSession,
  currentMode,
  leadPartsFor,
  presentedBp3Core,
  promptMode,
  rewriteConversationBp3Core,
  schemaTools,
  toolName,
} from './surface-helpers.mjs';

const AGENT_PROFILE_INTENT = 'agent_profile';
// Pending prompt changes folded in where the cache is cold anyway.
const PROMPT_FOLD_INTENT = 'prompt_fold';
// Cache-break intents that already rebuild the conversation's cached prefix.
const COLD_INTENTS = new Set(['post_turn_compaction', 'manual_compaction']);

// What the next request sends ahead of the conversation: the system blocks and tools.
const promptPrefix = (session) =>
  JSON.stringify([
    (Array.isArray(session.messages) ? session.messages : [])
      .filter((message) => message?.role === 'system')
      .map((message) => message.content),
    session.tools,
  ]);

// A bot thread built from other shipped rules than these (a release changed one).
const rulesStale = (session) =>
  sessionModeOf(session) === AGENT_MODE && session.rulesRevision !== promptRulesRevision();

// Before session-local modes were used by profile refreshes, changing the
// roster could replace a coding Lead's mode rules with the configured default
// while leaving its selected mode intact. This is not a normal mode overlay:
// repair only a known generated mismatch, with no user switch still pending.
function orchestrationRecoveryNeeded(session) {
  if (
    !session?.promptIdentity ||
    session.promptIdentity.skipAgentRules ||
    isAgentOwner(session) ||
    sessionModeOf(session) === AGENT_MODE ||
    !ORCHESTRATION_MODES.includes(session.orchestrationMode) ||
    session.workflowOverlay ||
    session.orchestrationModeOverlay ||
    session.pendingWorkflowId !== undefined ||
    session.pendingOrchestrationMode !== undefined
  ) return false;
  const presented = orchestrationModeFromPrompt(session);
  return presented !== null && presented !== session.orchestrationMode;
}

// Changes the prompt does not carry yet: a workflow switched mid-conversation,
// a bot's tool gates that moved, or shipped rules a release changed.
const foldPending = (session) =>
  Boolean(
    session.workflowOverlay || session.orchestrationModeOverlay || session.promptFoldPending || rulesStale(session)
  );

// A switch's reminder that is neither pending nor still in the conversation.
const reminderDropped = (session, overlay, notice) =>
  Boolean(overlay && !notice && !conversationHolds(session, overlay.content));

// The cached prefix is cold anyway, so folding pending changes costs nothing
// extra: a compaction (tagged, or one that dropped a delivered workflow
// reminder), a cleared conversation, or a message tail the provider's cache
// already let expire (sessionTailCacheExpired; never for openai-oauth).
function cacheCold(session) {
  if (COLD_INTENTS.has(session.pendingCacheBreakIntent)) return true;
  if (!sessionHasConversationMessages(session)) return true;
  if (sessionTailCacheExpired(session)) return true;
  return (
    reminderDropped(session, session.workflowOverlay, session.workflowSwitch) ||
    reminderDropped(session, session.orchestrationModeOverlay, session.orchestrationModeSwitch)
  );
}

// The connector tools among `names` the session's agent may run now.
function connectorTools(session, names) {
  const agent = connectorPolicyAgentOf(session);
  return [...names]
    .filter((name) => name.startsWith('mcp__') && agentMcpToolPermission(agent, name) !== 'disabled')
    .sort();
}

// A bot thread's tools that changed without its prompt: feature gates that
// opened (or closed) and connectors added or removed. Nothing in the request
// prefix moves. An opened tool joins the deferred catalog — reachable by
// deferred loading, which brings its schema into the conversation — and a
// gone one is refused at call time; the next turn's deferred_tools_delta
// notice names both. Gate changes are folded into the prompt at the next
// cold point (promptFoldPending). Connectors live in the bot's agent.json,
// so they are compared only when its profile stamp moved (`edited`).
// Returns true when anything changed.
function stageLiveToolChanges({ liveDeniedTools, modelStandaloneTools }, session, workflow, { edited = false } = {}) {
  const added = [];
  const removed = [];
  const known = new Map(schemaTools(session).map((tool) => [toolName(tool), tool]));
  const live = new Set(liveDeniedTools(session, workflow));
  const disallowed = (session.disallowedTools || []).map(String);
  const opened = disallowed.filter((name) => !live.has(name));
  const closed = [...live].filter((name) => known.has(name) && !disallowed.includes(name));
  if (opened.length || closed.length) {
    const fresh = modelStandaloneTools().filter(
      (tool) => opened.includes(toolName(tool)) && !known.has(toolName(tool))
    );
    if (fresh.length) session.deferredToolCatalog = [...(session.deferredToolCatalog || []), ...fresh];
    for (const tool of fresh) known.set(toolName(tool), tool);
    session.disallowedTools = [...live];
    added.push(...opened.filter((name) => known.has(name)));
    removed.push(...closed);
    session.promptFoldPending = true;
  }
  // Connectors gate MCP tools at call time only (pre-dispatch-deny.mjs).
  const previous = session.agentConnectorTools;
  const permitted = edited || !Array.isArray(previous) ? connectorTools(session, known.keys()) : previous;
  session.agentConnectorTools = permitted;
  if (edited && Array.isArray(previous)) {
    added.push(...permitted.filter((name) => !previous.includes(name)));
    removed.push(...previous.filter((name) => !permitted.includes(name)));
  }
  if (!added.length && !removed.length) {
    return opened.length + closed.length > 0 || !Array.isArray(previous);
  }
  mergePendingDeferredToolDelta(session, {
    added: added.map((name) => ({ name, description: known.get(name)?.description || '' })),
    removed,
  });
  session.updatedAt = Date.now();
  return true;
}

export function createAgentProfileFold({
  getSession,
  getConfig,
  getDataDir,
  modelStandaloneTools,
  activeWorkflowContext,
  liveDeniedTools,
  stagePolicy,
  applyPolicy,
  turnInFlight,
}) {
  // An agent profile edit that met a running turn: the next turn applies it.
  let agentProfilePending = false;

  // Fold every pending change into the prompt: the session's own workflow,
  // its tool gates and the shipped rules as they stand now, with every stamp
  // moved. One cache break, tagged with the intent already pending (a
  // compaction) or `intent`. Returns true when the request prefix changed.
  async function foldPrompt(session, intent) {
    const identity = session.promptIdentity;
    if (!identity) return false;
    const agentMode = sessionModeOf(session) === AGENT_MODE;
    const config = configForSession(getConfig(), session.workflow?.id, currentMode(session));
    const staged = await stagePolicy(session, identity, config, { conversation: true });
    if (getSession?.() !== session) return false;
    const before = promptPrefix(session);
    applyPolicy(session, staged);
    rewriteConversationBp3Core(session, staged.core);
    if (session.agentProfileRevision !== undefined) {
      session.agentProfileRevision = agentProfileRevision(identity.agent, { mixy: agentMode });
      const { leadPromptParts } = activeWorkflowContext(config, getDataDir());
      session.agentRosterRevision = leadRosterRevision(leadPartsFor(session, leadPromptParts));
    }
    if (agentMode) session.rulesRevision = promptRulesRevision();
    session.updatedAt = Date.now();
    if (promptPrefix(session) === before) return false;
    markToolSurfaceMigrated(session, session.pendingCacheBreakIntent || intent);
    return true;
  }

  /** Fold pending prompt changes (a switched workflow, a bot's moved tool
   *  gates, changed shipped rules) when the cache is cold anyway. */
  async function foldPromptIfCold() {
    const session = getSession?.();
    if (!session?.id || !session.promptIdentity || isAgentOwner(session)) return false;
    if (!foldPending(session) || !cacheCold(session)) return false;
    return foldPrompt(session, PROMPT_FOLD_INTENT);
  }

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
   * turn. That rewrite is immediate (one tagged cache break) and takes every
   * pending fold with it (foldPrompt), moving all stamps.
   * What is not an edit never touches the prefix: a bot thread's feature gates
   * and connectors are staged live (stageLiveToolChanges), and shipped rules a
   * release changed wait silently; both are folded in at the next cold point
   * (foldPromptIfCold). Returns true when the session changed (save it).
   */
  async function refreshAgentProfile({ trigger = 'save' } = {}) {
    const session = getSession?.();
    const identity = session?.promptIdentity;
    const agent = identity?.agent;
    if (!session?.id || !agent || isAgentOwner(session)) return false;
    // Only Mixy's own (agent-mode) thread embeds Mixy's profile.
    const agentMode = sessionModeOf(session) === AGENT_MODE;
    const revision = agentProfileRevision(agent, { mixy: agentMode });
    // The roster the prompt lists is the prompt's workflow's (a switched
    // workflow is not an edit).
    const workflowConfig = configForSession(getConfig(), promptWorkflowOf(session)?.id, promptMode(session));
    const { leadPromptParts, summary: workflow } = activeWorkflowContext(workflowConfig, getDataDir());
    const roster = leadRosterRevision(leadPartsFor(session, leadPromptParts));
    const recoverMode = orchestrationRecoveryNeeded(session);
    const edited = recoverMode || session.agentProfileRevision !== revision || session.agentRosterRevision !== roster;
    // At a turn's start its own turn is the one counted; nothing runs yet.
    const busy = () => getSession?.() !== session || (trigger !== 'turn' && turnInFlight(session));
    if (busy()) {
      agentProfilePending = true;
      return false;
    }
    const toolsChanged =
      agentMode &&
      stageLiveToolChanges({ liveDeniedTools, modelStandaloneTools }, session, workflow, {
        edited: session.agentProfileRevision !== revision,
      });
    if (!edited) return (trigger === 'resume' && (await foldPromptIfCold())) || toolsChanged;
    // A coding session from before profile stamps keeps its prompt when it
    // is reopened; a saved edit still reaches it.
    if (session.agentProfileRevision === undefined && trigger === 'resume' && !agentMode && !recoverMode) {
      return toolsChanged;
    }
    if (foldPending(session)) {
      await foldPrompt(session, AGENT_PROFILE_INTENT);
      return true;
    }
    const staged = await stagePolicy(session, identity, workflowConfig, { conversation: true });
    if (busy()) {
      agentProfilePending = true;
      return toolsChanged;
    }
    session.agentProfileRevision = revision;
    session.agentRosterRevision = roster;
    session.updatedAt = Date.now();
    if (staged.core === presentedBp3Core(session)) return toolsChanged;
    rewriteConversationBp3Core(session, staged.core);
    // The request prefix changed: one cache break, tagged on the next send.
    markToolSurfaceMigrated(session, recoverMode ? PROMPT_FOLD_INTENT : AGENT_PROFILE_INTENT);
    return true;
  }

  /** Turn start: apply an edit that arrived while the previous turn ran, then
   *  fold pending prompt changes if the cache is cold anyway. */
  async function applyPendingAgentProfile() {
    let changed = false;
    // A bot thread's connector baseline, before any edit can be compared to it.
    const session = getSession?.();
    if (session?.id && sessionModeOf(session) === AGENT_MODE && !Array.isArray(session.agentConnectorTools)) {
      session.agentConnectorTools = connectorTools(session, schemaTools(session).map(toolName));
    }
    if (agentProfilePending || orchestrationRecoveryNeeded(session)) {
      agentProfilePending = false;
      changed = await refreshAgentProfile({ trigger: 'turn' });
    }
    return (await foldPromptIfCold()) || changed;
  }

  return { refreshAgentProfile, applyPendingAgentProfile };
}
