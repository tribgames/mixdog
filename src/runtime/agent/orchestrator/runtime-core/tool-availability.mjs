// Settings-gated tool availability for a live session. A session records the
// gates it was built with in `disallowedTools`; when a gate moves, a
// conversation is never re-prefixed: an opened tool joins the late deferred
// catalog (deferredLateToolCatalog — never the boot catalog, whose bytes a
// native request keeps) and a closed one joins the enforced deny set. The next
// prompt's deferred_tools_delta names both, and the prompt is folded at the
// next cache-cold point (promptFoldPending).
import { clean } from './session-text.mjs';
import { FEATURE_GATED_TOOL_NAMES, SETTING_GATED_TOOL_NAMES, featureDisallowedToolsFor } from './builtin-features.mjs';
import { mergePendingDeferredToolDelta } from './deferred-tool-delta.mjs';
import { sessionAllowlistExcludes } from './deferred-tool-availability.mjs';
import { isAgentOwner } from '../agent-owner.mjs';
import { agentMcpToolPermission, connectorPolicyAgentOf, projectMcpToolDisabled } from '../mcp/agent-connectors.mjs';
import { reactionDisabled } from '../session/manager/session-tool-surface.mjs';
import { browserBridgeAvailableSync } from '../../../browser-bridge/client.mjs';
import { computerBridgeAvailableSync } from '../../../computer-bridge/client.mjs';
import { terminalBridgeAvailableSync } from '../../../terminal-bridge/client.mjs';

const GATED = new Set(FEATURE_GATED_TOOL_NAMES);
const SETTING_GATED = new Set(SETTING_GATED_TOOL_NAMES);
// web_fetch keeps its gate under the transports it is routed to (pre-dispatch-deny.mjs).
const FETCH_TRANSPORTS = new Set(['local_fetch', 'image_fetch']);

// MCP scope → the live gate list of the session runtime serving it.
const liveGateSources = new Map();

/** A session runtime's live gate list (its in-memory settings) for model
 *  calls in its MCP scope. Returns the unregister function. */
export function registerLiveFeatureGates(scopeId, featureDisallowedTools) {
  const key = scopeId ?? null;
  liveGateSources.set(key, featureDisallowedTools);
  return () => {
    if (liveGateSources.get(key) === featureDisallowedTools) liveGateSources.delete(key);
  };
}

/**
 * The setting that turns off `name` right now, or null. A session's deny set
 * takes moved gates at its next turn start; this covers a turn already
 * running when a setting changed.
 */
export function settingDisabledTool(name, scopeId) {
  const source = liveGateSources.get(scopeId ?? null);
  return typeof source === 'function' ? settingDisabledIn(name, source()) : null;
}

/** The setting of the live gate list `denied` that turns off `name`, or null. */
export function settingDisabledIn(name, denied) {
  const gated = FETCH_TRANSPORTS.has(name) ? 'web_fetch' : name;
  return SETTING_GATED.has(gated) && (denied || []).includes(gated) ? gated : null;
}

/** The feature gates as they stand: `config` plus live desktop-bridge presence. */
export function liveFeatureDisallowedTools(config, { toolProfile } = {}) {
  return featureDisallowedToolsFor(config, {
    browserAvailable: browserBridgeAvailableSync(),
    computerAvailable: computerBridgeAvailableSync(),
    terminalAvailable: terminalBridgeAvailableSync(),
    toolProfile,
  });
}

function knownTools(session) {
  const known = new Map();
  for (const key of ['tools', 'deferredToolCatalog', 'deferredLateToolCatalog']) {
    for (const tool of Array.isArray(session?.[key]) ? session[key] : []) {
      const name = clean(tool?.name);
      if (name && !known.has(name)) known.set(name, tool);
    }
  }
  return known;
}

/**
 * Bring `session`'s settings-gated tools to `featureDenied` (the live gate
 * list) without touching its request prefix. `definitionsFor(names)` supplies
 * definitions for opened tools the session never held. Returns
 * `{ added, removed }` when a gate moved, else null.
 */
export function stageToolAvailability(session, featureDenied, definitionsFor = () => []) {
  if (!session || !Array.isArray(session.tools)) return null;
  const live = new Set((featureDenied || []).map(String).filter((name) => GATED.has(name)));
  session.featureDeniedTools = [...live].sort();
  const disallowed = (session.disallowedTools || []).map(String);
  const denied = new Set(disallowed);
  // Denials that are not settings: the caller's, and react outside a bot chat.
  const fixed = new Set((session.callerDisallowedTools || []).map(String));
  if (reactionDisabled(session, isAgentOwner(session))) fixed.add('react');
  const closed = [...live].filter((name) => !denied.has(name));
  const opened = disallowed.filter((name) => GATED.has(name) && !live.has(name) && !fixed.has(name));
  if (!closed.length && !opened.length) return null;
  const known = knownTools(session);
  const missing = opened.filter((name) => !known.has(name));
  const fresh = missing.length
    ? (definitionsFor(missing) || []).filter((tool) => missing.includes(clean(tool?.name)))
    : [];
  for (const tool of fresh) {
    if (!known.has(clean(tool.name))) known.set(clean(tool.name), tool);
  }
  if (fresh.length) {
    session.deferredLateToolCatalog = [...(session.deferredLateToolCatalog || []), ...fresh];
  }
  const openedSet = new Set(opened);
  session.disallowedTools = [...disallowed.filter((name) => !openedSet.has(name)), ...closed];
  const visible = (name) => known.has(name) && !sessionAllowlistExcludes(session, name);
  const added = opened.filter(visible);
  const removed = closed.filter(visible);
  mergePendingDeferredToolDelta(session, {
    added: added.map((name) => ({ name, description: known.get(name)?.description || '' })),
    removed,
  });
  // A delegated worker is never folded (agent-profile-fold.mjs): its opened
  // tools are re-announced after a compaction instead (rearmLateDeferredTools).
  if (!isAgentOwner(session)) session.promptFoldPending = true;
  session.updatedAt = Date.now();
  return { added, removed };
}

// The connector tools among the session's known tools that its agent's
// connector policy and its project's connector switches let it run now.
function permittedConnectorTools(session, known) {
  const agent = connectorPolicyAgentOf(session);
  return [...known.keys()]
    .filter(
      (name) =>
        name.startsWith('mcp__') &&
        agentMcpToolPermission(agent, name) !== 'disabled' &&
        !projectMcpToolDisabled(session, name)
    )
    .sort();
}

/**
 * Connector switches (an agent's policy, a project's connector off/on) gate
 * MCP tools at call time (pre-dispatch-deny.mjs); this tells the model. The
 * first call records the baseline; later moves join the deferred_tools_delta.
 * Returns `{ added, removed }` when the permitted set moved, else null.
 */
export function stageConnectorAvailability(session) {
  if (!session || !Array.isArray(session.tools)) return null;
  const known = knownTools(session);
  const permitted = permittedConnectorTools(session, known);
  const previous = session.agentConnectorTools;
  session.agentConnectorTools = permitted;
  if (!Array.isArray(previous)) return null;
  const added = permitted.filter((name) => !previous.includes(name));
  const removed = previous.filter((name) => !permitted.includes(name));
  if (!added.length && !removed.length) return null;
  mergePendingDeferredToolDelta(session, {
    added: added.map((name) => ({ name, description: known.get(name)?.description || '' })),
    removed,
  });
  session.updatedAt = Date.now();
  return { added, removed };
}
