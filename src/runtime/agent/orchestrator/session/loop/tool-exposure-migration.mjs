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
  TOOL_SURFACE_MIGRATION_INTENT,
  toolExposureMigrationNeeded,
  toolExposureModeForProvider,
} from '../../runtime-core/tool-exposure.mjs';
import { applyInitialDeferredToolManifestToBp2 } from '../../context/collect.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { honoredSchemaAllowlist } from '../manager/session-tool-surface.mjs';
import { syncSystemPrefix } from '../manager/prompt-utils.mjs';
import { invalidateProviderContextBaseline } from './compact-policy.mjs';

/** Drop everything measured against the previous tool surface. */
function invalidateForToolSurfaceMigration(session) {
  delete session.providerState;
  delete session._providerPrefixGuardState;
  invalidateProviderContextBaseline(session);
  session.updatedAt = Date.now();
}

/**
 * After a surface re-apply outside a request (resume, provider switch)
 * migrated the exposure: the first send of the next turn carries the tag.
 */
export function markToolSurfaceMigrated(session) {
  invalidateForToolSurfaceMigration(session);
  session.pendingCacheBreakIntent = TOOL_SURFACE_MIGRATION_INTENT;
}

/** Provider switch: rebuild the surface for `provider`, migrating bridge ↔ native. */
export function rebuildToolSurfaceForProviderWithMigration(session, provider) {
  if (!session) return false;
  const migrating = toolExposureMigrationNeeded(session, provider);
  rebuildDeferredToolSurfaceForProvider(session, provider);
  if (migrating) markToolSurfaceMigrated(session);
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
  const stored = session.messages;
  const working = Array.isArray(messages) ? messages : stored;
  if (Array.isArray(working)) session.messages = working;
  try {
    applyDeferredToolSurface(session, session.deferredSurfaceMode || 'lead', [], {
      provider: session.provider,
      model: session.model,
    });
  } finally {
    if (Array.isArray(working) && session.messages !== working) {
      // The rewrite may drop an emptied system message: keep the request
      // transcript array identity the loop holds.
      working.splice(0, working.length, ...session.messages);
    }
    session.messages = stored;
  }
  // The rewritten prompt messages are fresh objects; the canonical transcript
  // the save path persists takes them too, so the next save writes the new
  // prompt together with the new exposure.
  if (Array.isArray(stored) && Array.isArray(working) && stored !== working) syncSystemPrefix(stored, working);
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
