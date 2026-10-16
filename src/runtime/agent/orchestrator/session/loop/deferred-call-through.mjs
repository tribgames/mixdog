// Deferred catalog call-through: inactive catalog tool_use → discovery bookkeeping
// then normal executeTool routing (runtime errors only; no pre-dispatch schema).
import { clean } from '../../runtime-core/session-text.mjs';
import { deferredCatalogUnion, isReadonlySelectable, selectDeferredTools } from '../../runtime-core/tool-catalog.mjs';
import { isDeferredToolAvailable } from '../../runtime-core/deferred-tool-availability.mjs';
import { routeToolExclusionReason } from './provider-tool-exclusions.mjs';
import { isBridgeReadonlySession, isToolBridgeEnabled } from '../../runtime-core/tool-bridge.mjs';

/** Skill-list plumbing only; mutation/MCP/builtins must use the catalog+mode gate. */
const INACTIVE_INFRA_BYPASS = new Set(['skills_list', 'skill_view']);

function isActiveSessionTool(session, name) {
  const key = clean(name);
  if (!key || !Array.isArray(session?.tools)) return false;
  return session.tools.some((tool) => clean(tool?.name) === key);
}

function lookupDeferredCatalogTool(session, name) {
  // Union of the boot-frozen catalog and the late-connected MCP catalog so a
  // direct call to a tool whose server connected after boot resolves and
  // records it in the independent callable registry.
  const catalog = deferredCatalogUnion(session);
  const key = clean(name);
  if (!key) return null;
  for (const tool of catalog) {
    const n = clean(tool?.name);
    if (n === key || n.toLowerCase() === key.toLowerCase()) return tool;
  }
  return null;
}

export function isOnDeferredToolSurface(session, name) {
  if (!session) return false;
  if (!isDeferredToolAvailable(session, name)) return false;
  return isActiveSessionTool(session, name) || lookupDeferredCatalogTool(session, name) !== null;
}

function toolExecutesWhenInactive(name) {
  return INACTIVE_INFRA_BYPASS.has(name);
}

export function resolveDeferredSelectMode(session) {
  const spec = session?.toolSpec;
  if (spec == null || spec === '') return null;
  if (spec === 'readonly') return 'readonly';
  if (spec === 'full' || spec === 'mcp') return 'full';
  if (Array.isArray(spec)) {
    if (!spec.length) return null;
    if (spec.includes('full')) return 'full';
    if (spec.includes('tools:readonly')) return 'readonly';
    return 'full';
  }
  return null;
}

/**
 * Read-only sessions (webhook runs, the read-only lead mode) run only what
 * their surfaces offer: active tools, catalog tools (whose readonly gate is
 * the call-through below) and skill-list plumbing. Any other name — a write
 * tool, an adapter alias for one — is outside the read-only bundle.
 */
export function isOffReadonlySurface(session, name) {
  if (resolveDeferredSelectMode(session) !== 'readonly') return false;
  const key = clean(name);
  if (!key || INACTIVE_INFRA_BYPASS.has(key)) return false;
  const lower = key.toLowerCase();
  const active = Array.isArray(session?.tools) ? session.tools : [];
  if (active.some((tool) => clean(tool?.name).toLowerCase() === lower)) return false;
  return lookupDeferredCatalogTool(session, key) === null;
}

function denyDeferredCallThrough(message) {
  return { deny: message };
}

/**
 * Inactive deferred catalog hits: readonly/mode gate + callable registration,
 * or deny. Native provider schema arrays are never mutated here.
 * Returns null when not applicable (not in catalog, already active, infra allowlist).
 */
export function prepareDeferredToolCallThrough(sessionRef, name) {
  if (!sessionRef) return null;
  if (!isDeferredToolAvailable(sessionRef, name)) {
    return denyDeferredCallThrough(
      `Error: MCP tool "${name}" is unavailable in the current session catalog; no call was sent.`
    );
  }
  const tool = lookupDeferredCatalogTool(sessionRef, name);
  if (!tool) return null;
  const routeExclusion = isToolBridgeEnabled(sessionRef) ? null : routeToolExclusionReason(sessionRef, tool);
  if (routeExclusion) return denyDeferredCallThrough(`Error: ${routeExclusion}`);
  if (isActiveSessionTool(sessionRef, name)) return null;
  if (toolExecutesWhenInactive(name)) return null;

  const toolLabel = clean(tool.name) || clean(name) || 'tool';
  const bridge = isToolBridgeEnabled(sessionRef);
  const resolvedMode = resolveDeferredSelectMode(sessionRef);
  // Whatever the exposure, a deferred mutating tool never runs without a
  // resolved tool mode, and never in a read-only one.
  if (resolvedMode === null) {
    if (!isReadonlySelectable(tool)) {
      const remedy = bridge ? 'no call was sent.' : `load it with load_tool names:["${toolLabel}"].`;
      return denyDeferredCallThrough(
        `Error: tool "${toolLabel}" is deferred and cannot be auto-loaded without a resolved tool mode; ${remedy}`
      );
    }
  } else if (
    (resolvedMode === 'readonly' || (bridge && isBridgeReadonlySession(sessionRef))) &&
    !isReadonlySelectable(tool)
  ) {
    return denyDeferredCallThrough(`Error: tool "${toolLabel}" is not available in readonly mode`);
  }
  // Bridge sessions reach deferred tools through call_tool: the fixed
  // provider surface is never extended.
  if (bridge) return null;

  const selectMode = resolvedMode === null ? 'readonly' : resolvedMode;
  selectDeferredTools(sessionRef, [toolLabel], selectMode);
  return null;
}
