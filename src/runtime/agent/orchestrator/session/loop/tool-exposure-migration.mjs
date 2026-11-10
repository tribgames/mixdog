// Tool-exposure migration (native ↔ bridge-v1, and pre-versioned fixed
// surfaces → bridge-v1). The surface itself is rebuilt by
// applyDeferredToolSurface; this module adds what a changed request prefix
// invalidates: provider state, the prefix guard, the context baseline and the
// cache-break tag. Historical tool calls are never rewritten.
import { applyDeferredToolSurface, rebuildDeferredToolSurfaceForProvider } from '../../runtime-core/tool-catalog.mjs';
import {
  bridgeSurfaceOutdated,
  sessionToolExposure,
  TOOL_EXPOSURE_BRIDGE,
  TOOL_EXPOSURE_NATIVE,
  TOOL_SURFACE_MIGRATION_INTENT,
  toolExposureMigrationNeeded,
  toolExposureModeForProvider,
} from '../../runtime-core/tool-exposure.mjs';
import { applyInitialDeferredToolManifestToBp2 } from '../../context/collect.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { honoredSchemaAllowlist } from '../manager/session-tool-surface.mjs';
import { syncSystemPrefix } from '../manager/prompt-utils.mjs';
import { invalidateProviderContextBaseline } from './compact-policy.mjs';
import { rebindToChangedPrefix } from '../thinking-binding.mjs';

/** Drop everything measured against the previous tool surface. */
function invalidateForToolSurfaceMigration(session) {
  delete session.providerState;
  delete session._providerPrefixGuardState;
  invalidateProviderContextBaseline(session);
  session.updatedAt = Date.now();
}

/**
 * After a surface re-apply outside a request (resume, provider switch, a
 * workflow switch: `intent`) changed the request prefix: the first send of the
 * next turn carries the tag.
 */
export function markToolSurfaceMigrated(session, intent = TOOL_SURFACE_MIGRATION_INTENT) {
  invalidateForToolSurfaceMigration(session);
  // The stored thinking was bound to the previous prefix and can never be
  // replayed again (../thinking-binding.mjs); an open tool round a stopped
  // turn left behind is ended first. Outside a turn only: a running turn sends
  // from its own working transcript, whose latest tool round must keep its
  // thinking.
  if (Array.isArray(session.messages) && !Array.isArray(session.liveTurnMessages)) {
    session.messages = rebindToChangedPrefix(session.messages);
  }
  session.pendingCacheBreakIntent = intent;
}

/**
 * Run `apply` with `messages` (the transcript a running turn works on) as the
 * session's messages, so a fixed-guidance rewrite lands there; the canonical
 * transcript takes the rewritten system prefix. Without `messages`, `apply`
 * runs on the session's own. `apply` runs synchronously.
 */
function applyOnWorkingMessages(session, messages, apply) {
  const stored = session.messages;
  const working = Array.isArray(messages) ? messages : stored;
  if (Array.isArray(working)) session.messages = working;
  try {
    apply();
  } finally {
    if (Array.isArray(working) && session.messages !== working) {
      // The rewrite may drop an emptied system message: keep the array
      // identity the request loop holds.
      working.splice(0, working.length, ...session.messages);
    }
    session.messages = stored;
  }
  // The rewritten prompt messages are fresh objects; the canonical transcript
  // the save path persists takes them too, so the next save writes the new
  // prompt together with the new exposure.
  if (Array.isArray(stored) && Array.isArray(working) && stored !== working) syncSystemPrefix(stored, working);
}

/**
 * Provider switch: rebuild the surface for `provider`, migrating bridge ↔
 * native. `messages`: the running turn's transcript, when a switch happens
 * mid-turn (a route fallback hop).
 */
export function rebuildToolSurfaceForProviderWithMigration(session, provider, messages) {
  if (!session) return false;
  const migrating = toolExposureMigrationNeeded(session, provider);
  applyOnWorkingMessages(session, messages, () => {
    rebuildDeferredToolSurfaceForProvider(session, provider);
    if (migrating) markToolSurfaceMigrated(session);
  });
  return migrating;
}

// The latest assistant tool turn still waits for a result: not a safe boundary.
function hasUnansweredToolCalls(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const index = list.findLastIndex((message) => message?.role === 'assistant' && message.toolCalls?.length);
  if (index < 0) return false;
  const answered = new Set(
    list.slice(index + 1).flatMap((message) => (message?.role === 'tool' ? [message.toolCallId] : []))
  );
  return list[index].toolCalls.some((call) => call?.id && !answered.has(call.id));
}

/**
 * Request-boundary migration of a live session whose persisted exposure
 * differs from its provider's. `messages` is the transcript the request is
 * built from; the fixed-guidance rewrite lands there (and on the session).
 * Returns true when the surface changed; the caller drops its frozen tool
 * snapshot and provider state and tags the send.
 */
export function migrateToolExposureAtBoundary(session, messages) {
  if (!session || !toolExposureMigrationNeeded(session) || hasUnansweredToolCalls(messages)) return false;
  applyOnWorkingMessages(session, messages, () =>
    applyDeferredToolSurface(session, session.deferredSurfaceMode || 'lead', [], {
      provider: session.provider,
      model: session.model,
    })
  );
  invalidateForToolSurfaceMigration(session);
  return true;
}

// Bridge state an agent surface carries; dropped when it returns to the full array.
const AGENT_BRIDGE_FIELDS = [
  'toolExposureMode',
  'deferredProviderMode',
  'deferredNativeTools',
  'deferredSurfaceMode',
  'deferredToolUsage',
  'deferredDefaultTools',
  'deferredSelectedTools',
  'deferredDiscoveredTools',
  'deferredCallableTools',
  'deferredAnnouncedTools',
  'deferredToolDeltaRevision',
  'nativeDeferredDiscovery',
  'mcpServerInstructions',
  'mcpInstructionsAnnounced',
];

/**
 * Agent (worker) sessions. Call right after their tools were resolved
 * (create, resume, route change): on a bridge provider the eager surface
 * becomes the full-mode core plus the bridge, built only from those
 * role/policy-filtered tools; a native provider keeps the full array. A
 * session honouring its own schema allowlist (a hidden specialist role) is
 * already a small explicit surface and keeps it. `existing`: the session had
 * a surface before, so a changed exposure is a migration.
 */
export function applyAgentToolExposure(session, { existing = false } = {}) {
  if (!session || !Array.isArray(session.tools) || !isAgentOwner(session)) return false;
  const before = sessionToolExposure(session);
  const allowlisted = honoredSchemaAllowlist(session.schemaAllowedTools, { ownerIsAgent: true, agent: session.agent });
  const bridge =
    !allowlisted && toolExposureModeForProvider(session.provider, session.wireRoute) === TOOL_EXPOSURE_BRIDGE;
  if (!bridge && before === null) return false;
  // A native deferred surface (the session runtime builds one) stays one:
  // re-selected over the tools just resolved, never stripped to the full
  // array. Native → native is no exposure change, so nothing is tagged.
  if (!bridge && before === TOOL_EXPOSURE_NATIVE) {
    session.tools = session.tools.slice();
    applyDeferredToolSurface(session, session.deferredSurfaceMode || 'full', [], {
      provider: session.provider,
      model: session.model,
    });
    return false;
  }
  // A surface an earlier bridge revision built is rebuilt now.
  const outdated = bridgeSurfaceOutdated(session);
  // The tools just resolved are the whole authority: no earlier catalog, MCP
  // availability snapshot or pending MCP delta survives. (A bridge surface
  // re-takes the snapshot at its next request boundary; a native agent has no
  // refresh, so a stale snapshot would hide a connected server's tools.)
  delete session.deferredToolCatalog;
  delete session.deferredLateToolCatalog;
  delete session.deferredMcpToolNames;
  delete session.pendingDeferredToolDelta;
  if (bridge) {
    // The resolved list may be shared (prepared-resume cache): rebuild a copy.
    session.tools = session.tools.slice();
    applyDeferredToolSurface(session, 'full', [], { provider: session.provider, model: session.model });
  } else {
    for (const field of AGENT_BRIDGE_FIELDS) delete session[field];
    // Without bridge state the fixed slot composes empty: the guidance goes.
    if (Array.isArray(session.messages)) applyInitialDeferredToolManifestToBp2(session, [], { rebuild: true });
    delete session.deferredToolBp2Applied;
  }
  const changed = before !== sessionToolExposure(session) || outdated;
  if (existing && changed) markToolSurfaceMigrated(session);
  return changed;
}
