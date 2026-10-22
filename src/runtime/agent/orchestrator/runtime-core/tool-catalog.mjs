// Deferred-tool catalog: measured-usage ordering, kind/bucket classification,
// tool_search ranking + auto-selection, and the session tool-surface
// application/selection logic. Pure module (session objects passed in).
import { clean } from './session-text.mjs';
import { mergePendingDeferredToolDelta } from './deferred-tool-delta.mjs';
import { applyInitialDeferredToolManifestToBp2 } from '../context/collect.mjs';
import { listedDeferredToolNames } from '../context/deferred-tools.mjs';
import { parseMcpToolName } from '../../../shared/tool-primitives.mjs';
import { getMcpServerInstructionsMap, getMcpTools, getMcpToolGeneration } from '../mcp/client.mjs';
import { filterMcpToolsForSession } from './extension-scopes.mjs';
import { isDeferredToolAvailable, isToolPermittedBySessionPolicy } from './deferred-tool-availability.mjs';
import { routeToolExclusionReason } from '../session/loop/provider-tool-exclusions.mjs';
import { isResponsesFreeformTool, toResponsesCustomTool } from '../providers/custom-tool-wire.mjs';
import {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  DEFERRED_SELECT_ALIASES,
  MEASURED_TOOL_USAGE,
  READONLY_TOOL_NAMES,
} from './tool-catalog-data.mjs';
import {
  toolKind,
  measuredToolUsage,
  parseToolSelection,
  routeToolRank,
  sortedCatalogByMeasuredUsage,
  activeToolForSurface,
  immutableToolForSurface,
  deferredProviderMode,
  nativeProviderFamily,
} from './tool-catalog-schema.mjs';
import { filterModelEditTools } from '../../../shared/edit-tool-dialect.mjs';
import { describeBridgeTools, formatBridgeResult, isBridgeReadonlySession } from './tool-bridge.mjs';
import {
  bridgeSurfaceOutdated,
  isBridgeToolDefinition,
  isToolBridgeEnabled,
  sessionToolExposure,
  TOOL_EXPOSURE_BRIDGE,
  TOOL_EXPOSURE_NATIVE,
  toolExposureModeForProvider,
} from './tool-exposure.mjs';
import { TOOL_BRIDGE_TOOLS } from './tool-defs.mjs';
export {
  toolKind,
  toolSchemaBucket,
  estimateToolSchemaBreakdown,
  measuredToolUsage,
  parseToolSelection,
  sortedCatalogByMeasuredUsage,
} from './tool-catalog-schema.mjs';
export { snapshotProviderRequestTools } from './provider-request-snapshot.mjs';
export {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  MEASURED_TOOL_USAGE,
} from './tool-catalog-data.mjs';

// Provider modes without native tool search. Their bridge-v1 sessions
// (tool-exposure.mjs) get the native roster and late delta notices; only a
// surface not yet migrated to the bridge keeps the fixed full array, with no
// deferred-pool manifest and no late announcements.
const FIXED_SURFACE_MODES = new Set(['full', 'manifest', 'canonical']);

function fixedSurfaceSession(session) {
  return FIXED_SURFACE_MODES.has(session?.deferredProviderMode) && !isToolBridgeEnabled(session);
}

// Whether a bridge session's roster and delta notices may name `tool`: only
// what its own policy (allowlist, denied tools, read-only mode) lets it run.
// Native rosters are unchanged.
function rosterPermits(session, tool) {
  if (!isToolBridgeEnabled(session)) return true;
  if (!isToolPermittedBySessionPolicy(session, clean(tool?.name))) return false;
  return !(isBridgeReadonlySession(session) && !isReadonlySelectable(tool));
}

// The bridge definitions every bridge session serializes: one frozen copy, so
// their bytes never vary across search, describe, call, skill loading or MCP
// connect/reconnect.
const BRIDGE_SURFACE_TOOLS = TOOL_BRIDGE_TOOLS.map((tool) => immutableToolForSurface(tool));

function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

function toolParameters(tool) {
  if (tool?.inputSchema && typeof tool.inputSchema === 'object') return tool.inputSchema;
  return { type: 'object', properties: {} };
}

// The rendered BP2 manifest text, or '' when no system message carries one.
function renderedDeferredManifest(session) {
  const system = session.messages?.find(
    (message) =>
      message?.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes('<available-deferred-tools>')
  );
  return system?.content ?? '';
}

export function filterDisallowedTools(tools, disallowed = []) {
  // Old session catalogs must not resurrect the separate staging schema.
  const deny = new Set(['git_stage', ...(Array.isArray(disallowed) ? disallowed : [])].map(clean).filter(Boolean));
  return (tools || []).filter((tool) => !deny.has(clean(tool?.name)));
}

/**
 * Discovery's view of `tools` for one session: what its own policy (schema
 * allowlist + denied tools) lets it execute. Nothing outside it is selected,
 * registered as discovered, described or named in a result.
 */
export function filterSessionToolPolicy(tools, session) {
  return filterDisallowedTools(tools, session?.disallowedTools).filter((tool) =>
    isToolPermittedBySessionPolicy(session, clean(tool?.name))
  );
}

// Predicate over tool names: false for a tool the session's route leaves out
// of every request (see routeToolExclusionReason).
function sentOnRoute(session, catalog) {
  const byName = new Map();
  for (const tool of [...(catalog || []), ...(Array.isArray(session?.tools) ? session.tools : [])]) {
    byName.set(clean(tool?.name), tool);
  }
  return (name) => !routeToolExclusionReason(session, byName.get(name));
}

const permittedNames = (session, names) =>
  (names || []).filter((name) => isToolPermittedBySessionPolicy(session, name));

export function sortedNamesByMeasuredUsage(names) {
  // Canonical route order first; measured usage orders the unrouted tail.
  return [...(names || [])].sort((a, b) => {
    const ar = routeToolRank(a);
    const br = routeToolRank(b);
    if (ar !== br) return ar - br;
    const au = measuredToolUsage(a);
    const bu = measuredToolUsage(b);
    if (bu !== au) return bu - au;
    return String(a).localeCompare(String(b));
  });
}

export function defaultDeferredToolNames(catalog, mode) {
  const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
  if (mode === 'lead') {
    return new Set(DEFERRED_DEFAULT_LEAD_TOOLS.filter((name) => available.has(name)));
  }
  if (mode === 'readonly') {
    return new Set(DEFERRED_DEFAULT_READONLY_TOOLS.filter((name) => available.has(name)));
  }
  return new Set(DEFERRED_DEFAULT_FULL_TOOLS.filter((name) => available.has(name)));
}

export function compactToolSearchDescription(value, max = 220) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Late-announcement lines stay skill-manifest shaped but much tighter than the
// BP1 pool (first sentence, hard 80-char cap): the reminder is transient
// discovery only — the full description/schema arrives when the tool loads.
function lateAnnouncementDescription(value) {
  const text = clean(value).replace(/\s+/g, ' ');
  const sentence = text.split(/(?<=[.!?])\s+/, 1)[0] || text;
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}

export function toolRow(tool, activeNames = new Set()) {
  const name = clean(tool?.name);
  return {
    name,
    kind: toolKind(tool),
    usage: measuredToolUsage(name),
    active: activeNames.has(name),
    description: compactToolSearchDescription(tool?.description),
  };
}

function providerSupportsResponsesCustomTools(provider) {
  const p = clean(provider).toLowerCase();
  if (!p) return true;
  return p === 'openai' || p === 'openai-oauth';
}

function openAILoadableToolSpec(tool, provider = '') {
  if (providerSupportsResponsesCustomTools(provider) && isResponsesFreeformTool(tool))
    return toResponsesCustomTool(tool);
  return {
    type: 'function',
    name: clean(tool?.name),
    description: clean(tool?.description),
    defer_loading: true,
    parameters: toolParameters(tool),
  };
}

export function toolSearchNativePayload(catalog, names, provider = '') {
  const selected = new Set((names || []).map(clean).filter(Boolean));
  if (!selected.size) return null;
  const tools = [];
  const refs = [];
  for (const tool of catalog || []) {
    const name = clean(tool?.name);
    if (!name || !selected.has(name)) continue;
    refs.push(name);
    tools.push(openAILoadableToolSpec(tool, provider));
  }
  if (!refs.length) return null;
  return {
    provider: clean(provider).toLowerCase(),
    toolReferences: refs,
    openaiTools: tools,
    summary: `Loaded deferred tools: ${refs.join(', ')}`,
  };
}

// Schemas for tools that are ALREADY active. They are deliberately NOT added
// to toolReferences/openaiTools: re-announcing them would rewrite the request
// tools array and break the cached prefix. The caller only ever sees names
// otherwise, so the parameter contract (enums, limits) rides in the RESULT.
function activeToolSchemas(catalog, session, names) {
  const wanted = new Set((names || []).map(clean).filter(Boolean));
  if (!wanted.size) return [];
  const seen = new Set();
  const specs = [];
  for (const pool of [Array.isArray(session?.tools) ? session.tools : [], catalog || []]) {
    for (const tool of pool) {
      const name = clean(tool?.name);
      if (!name || !wanted.has(name) || seen.has(name)) continue;
      seen.add(name);
      specs.push({ name, description: clean(tool?.description), parameters: toolParameters(tool) });
    }
  }
  return specs;
}

// Plain case-insensitive substring filter over name + description. No scores,
// no aliases, no auto-selection: tool_search only lists and (via select)
// loads. Empty query matches every row.
export function toolSearchMatches(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return true;
  const haystack = `${clean(row?.name)} ${clean(row?.description)}`.toLowerCase();
  return haystack.includes(raw);
}

function expandSelectionNames(names) {
  const out = [];
  for (const raw of names || []) {
    const key = clean(raw);
    if (!key) continue;
    const alias = DEFERRED_SELECT_ALIASES[key.toLowerCase()];
    if (alias) out.push(...alias);
    else out.push(key);
  }
  return [...new Set(out)];
}

/**
 * The tools of `tools` that `mcp__<server>` stands for (the deferred manifest
 * lists MCP servers, not their tools); [] for any other name. Callers try an
 * exact tool name first.
 */
export function mcpServerSelection(tools, requested) {
  const server = /^mcp__(.+)$/i.exec(clean(requested))?.[1]?.toLowerCase();
  if (!server) return [];
  return (tools || []).filter((tool) => String(parseMcpToolName(tool)?.server || '').toLowerCase() === server);
}

function storedDeferredToolNames(session) {
  for (const source of [session?.deferredDiscoveredTools, session?.deferredSelectedTools]) {
    const names = parseToolSelection(source);
    if (names.length) return names;
  }
  return [];
}

function canonicalDeferredToolNames(catalog, names) {
  const byName = new Map();
  for (const tool of catalog || []) {
    const name = clean(tool?.name);
    if (!name) continue;
    byName.set(name, name);
    byName.set(name.toLowerCase(), name);
  }
  const out = [];
  for (const raw of expandSelectionNames(names)) {
    const name = clean(raw);
    const canonical = byName.get(name) || byName.get(name.toLowerCase());
    if (canonical) out.push(canonical);
  }
  return sortedNamesByMeasuredUsage(new Set(out));
}

function setDeferredToolState(session, names) {
  if (!session) return [];
  const selected = sortedNamesByMeasuredUsage(new Set(parseToolSelection(names)));
  session.deferredDiscoveredTools = selected;
  session.deferredSelectedTools = selected;
  return selected;
}

function deferredPoolToolNames(session) {
  if (!session || fixedSurfaceSession(session)) return [];
  const catalog = Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : [];
  const active = new Set([
    ...(session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session.deferredCallableTools),
  ]);
  const out = [];
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (name && !active.has(name) && rosterPermits(session, tool)) out.push(name);
  }
  return sortedNamesByMeasuredUsage(out);
}

// Definition history combines the boot catalog with refreshed MCP definitions.
// Selection separately checks current availability. Native request snapshots
// expose only discovered definitions; the union never eagerly exposes the pool.
export function deferredCatalogUnion(session) {
  const boot = filterDisallowedTools(
    Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : [],
    session?.disallowedTools
  );
  const late = filterDisallowedTools(
    Array.isArray(session?.deferredLateToolCatalog) ? session.deferredLateToolCatalog : [],
    session?.disallowedTools
  );
  if (!late.length) return boot;
  const byName = new Map();
  // Refreshed definitions win same-name collisions without rewriting boot
  // metadata. Only selected, available schemas reach the next native request.
  for (const tool of boot) {
    const name = clean(tool?.name);
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  for (const tool of late) {
    const name = clean(tool?.name);
    if (name) byName.set(name, tool);
  }
  return [...byName.values()];
}

export function isReadonlySelectable(tool) {
  const name = clean(tool?.name);
  if (READONLY_TOOL_NAMES.has(name)) return true;
  const annotations = tool?.annotations || {};
  if (annotations.destructiveHint === true) return false;
  if (annotations.readOnlyHint === true) return true;
  return false;
}

export function applyDeferredToolSurface(session, mode, extraTools = [], options = {}) {
  if (!session || !Array.isArray(session.tools)) return session;
  const provider = options.provider || session.provider;
  // The pinned wire route decides a gateway's mode (it names its own
  // provider, so a surface built for another provider ignores it).
  const providerMode = deferredProviderMode(provider, session.wireRoute);
  const exposure = toolExposureModeForProvider(provider, session.wireRoute);
  const bridge = exposure === TOOL_EXPOSURE_BRIDGE;
  // An existing surface built for another exposure is migrated, not merely
  // re-selected: its fixed prompt guidance changes with it.
  const previousExposure = sessionToolExposure(session);
  // A surface an earlier bridge revision built (guidance-only prompt,
  // search_tools) is rebuilt once, the same rewrite an exposure change makes.
  const exposureChanged =
    previousExposure !== null && (previousExposure !== exposure || (bridge && bridgeSurfaceOutdated(session)));
  // The one native ↔ bridge transition, whoever triggers it (provider switch,
  // resume, request boundary): leaving native keeps its discoveries aside,
  // and the way back to native restores them below.
  if (previousExposure === TOOL_EXPOSURE_NATIVE && bridge) {
    session.nativeDeferredDiscovery = canonicalDeferredToolNames(
      deferredCatalogUnion(session),
      session.deferredDiscoveredTools || []
    );
  }
  const byName = new Map();
  // Rebuild from the full catalog, not just its eager projection. Current
  // definitions still take precedence over retained definitions. Bridge
  // definitions belong to the exposure, never to the catalog.
  const candidates = filterDisallowedTools(
    filterModelEditTools(
      [...session.tools, ...(extraTools || []), ...deferredCatalogUnion(session)].filter(
        (tool) => !isBridgeToolDefinition(tool)
      ),
      options.model || session.model
    ),
    [...(session.disallowedTools || []), ...(options.disallowed || [])]
  );
  for (const tool of candidates) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  // Solo keeps `agent` in the deferred pool: loadable on request, never eager.
  // The mode the prompt was built with: a mid-conversation workflow or
  // orchestration mode switch (workflowOverlay, orchestrationModeOverlay)
  // never reshapes the surface.
  let orchestrationMode = session.orchestrationMode;
  if (session.workflowOverlay) orchestrationMode = session.workflowOverlay.promptOrchestrationMode;
  else if (session.orchestrationModeOverlay) orchestrationMode = session.orchestrationModeOverlay.prompt;
  if (orchestrationMode === 'none') defaultNames.delete('agent');
  // Tools a workflow switch opened stay loadable, never eager, until the
  // prompt is rebuilt (session-runtime/tool-policy-refresh.mjs).
  for (const name of Array.isArray(session.workflowOpenedTools) ? session.workflowOpenedTools : []) {
    defaultNames.delete(name);
  }
  // Bridge sessions expose the mode's core only: a stored (legacy all-selected)
  // selection never widens the wire surface, and load_tool is the bridge's own.
  const storedNames = providerMode === 'native' || bridge ? [] : storedDeferredToolNames(session);
  let selectedNames = storedNames.length ? canonicalDeferredToolNames(catalog, storedNames) : [];
  if (!selectedNames.length || providerMode === 'native') selectedNames = sortedNamesByMeasuredUsage(defaultNames);
  if (bridge) selectedNames = selectedNames.filter((name) => name !== 'load_tool');
  const selected = new Set(selectedNames);
  session.deferredToolCatalog = catalog;
  session.deferredToolUsage = MEASURED_TOOL_USAGE;
  session.deferredDefaultTools = sortedNamesByMeasuredUsage(defaultNames);
  session.deferredProviderMode = providerMode;
  session.deferredNativeTools = providerMode === 'native';
  session.deferredSurfaceMode = mode;
  session.tools.length = 0;
  const active = [];
  for (const tool of catalog) {
    if (!selected.has(clean(tool?.name))) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    session.tools.push(tool);
    active.push(clean(tool?.name));
  }
  // Every other definition stays in the scoped catalog, reached through the
  // bridge. A tool-free session (empty catalog) stays tool-free.
  if (bridge && catalog.length) session.tools.push(...BRIDGE_SURFACE_TOOLS);
  if (bridge) session.toolExposureMode = TOOL_EXPOSURE_BRIDGE;
  else delete session.toolExposureMode;
  session.deferredCallableTools = sortedNamesByMeasuredUsage(active);
  if (providerMode === 'native') {
    const restored = previousExposure === TOOL_EXPOSURE_BRIDGE ? session.nativeDeferredDiscovery || [] : [];
    delete session.nativeDeferredDiscovery;
    const discovered = canonicalDeferredToolNames(catalog, [...(session.deferredDiscoveredTools || []), ...restored]);
    session.deferredSelectedTools = active;
    session.deferredDiscoveredTools = discovered.filter((name) => !selected.has(name));
  } else {
    setDeferredToolState(session, active);
  }
  if (exposureChanged && session.messages?.some((m) => m?.role === 'system')) {
    // Replace the previous exposure's fixed block once: the native deferred
    // manifest, or the bridge roster + guidance. History stays as is.
    session.mcpServerInstructions = getMcpServerInstructionsMap(session.mcpScopeId);
    applyInitialDeferredToolManifestToBp2(session, deferredPoolToolNames(session), { rebuild: true });
    session.deferredAnnouncedTools = listedDeferredToolNames(
      session,
      deferredPoolToolNames(session),
      renderedDeferredManifest(session)
    );
  }
  if (!session.deferredToolBp2Applied && session.messages?.some((m) => m?.role === 'system')) {
    if (!session.mcpServerInstructions || typeof session.mcpServerInstructions !== 'object') {
      session.mcpServerInstructions = getMcpServerInstructionsMap(session.mcpScopeId);
    }
    applyInitialDeferredToolManifestToBp2(session, deferredPoolToolNames(session));
  }
  if (!Array.isArray(session.deferredAnnouncedTools) && session.deferredToolBp2Applied) {
    // Seed the announced set with everything already advertised in the BP2
    // manifest, so the turn-boundary MCP delta (reconcileDeferredMcpToolCatalog)
    // only announces genuinely new, late-connecting tools and never re-announces
    // the startup pool.
    session.deferredAnnouncedTools = deferredPoolToolNames(session);
  }
  return session;
}

export function rebuildDeferredToolSurfaceForProvider(session, provider) {
  if (!session || !Array.isArray(session.tools)) return session;
  const previousFamily = nativeProviderFamily(session.provider, session.wireRoute);
  const nextFamily = nativeProviderFamily(provider, session.wireRoute);
  const preserveNativeState = previousFamily && previousFamily === nextFamily;
  const discovered = preserveNativeState
    ? canonicalDeferredToolNames(deferredCatalogUnion(session), session.deferredDiscoveredTools || [])
    : [];
  const catalog = deferredCatalogUnion(session).slice();
  const fromBridge = isToolBridgeEnabled(session);
  // Another native family starts without this family's discoveries. Leaving
  // native for the bridge keeps them: applyDeferredToolSurface sets them aside.
  if (nextFamily) session.deferredDiscoveredTools = discovered;
  // applyDeferredToolSurface replaces the fixed guidance when the exposure
  // (native ↔ bridge) changes.
  applyDeferredToolSurface(session, session.deferredSurfaceMode || 'lead', catalog, { provider });
  // Back from the bridge: the discoveries applyDeferredToolSurface restored
  // become callable again. Otherwise exactly the native family's own.
  const eager = new Set(session.tools.map((tool) => clean(tool?.name)));
  const kept = fromBridge
    ? sortedNamesByMeasuredUsage((session.deferredDiscoveredTools || []).filter((name) => !eager.has(name)))
    : discovered;
  if (session.deferredProviderMode === 'native' && kept.length) {
    session.deferredDiscoveredTools = kept;
    session.deferredCallableTools = sortedNamesByMeasuredUsage(
      new Set([...(session.deferredCallableTools || []), ...kept])
    );
    session.deferredSelectedTools = session.deferredCallableTools.slice();
  }
  return session;
}

// FIRST-TURN deferred-surface refresh (turn-time deferred manifest).
// An MCP server may finish its handshake BETWEEN session-create and the first
// user send. Fold those LIVE MCP tools into the boot deferred catalog + the
// provider-visible first-turn surface. Native providers rebuild the initial BP2
// <available-deferred-tools> manifest IN PLACE and pre-mark names announced;
// bridge-v1 sessions do the same (roster + bridge guidance). Only a fixed
// surface not yet on the bridge updates its scoped catalog alone. Fully sync
// and idempotent: no genuinely-new MCP name => no-op / no mutation.
export function refreshInitialDeferredMcpSurface(session, liveMcpTools) {
  if (!session || !Array.isArray(session.messages)) return false;
  if (session.deferredProviderMode === 'full') return false;
  const live = filterDisallowedTools(Array.isArray(liveMcpTools) ? liveMcpTools : [], session.disallowedTools);
  const byName = new Map();
  for (const tool of Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []) {
    const name = clean(tool?.name);
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  let added = false;
  for (const tool of live) {
    const name = clean(tool?.name);
    if (!name || !isMcpToolName(name) || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
    added = true;
  }
  if (!added) return false;
  session.deferredToolCatalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  if (fixedSurfaceSession(session)) {
    session.updatedAt = Date.now();
    return true;
  }
  // Refresh MCP server instructions so a newly-connected server's block is
  // included when BP2 is re-rendered below.
  session.mcpServerInstructions = getMcpServerInstructionsMap(session.mcpScopeId);
  const applied = applyInitialDeferredToolManifestToBp2(session, deferredPoolToolNames(session), { rebuild: true });
  if (!applied) return false;
  // Pre-mark ONLY the names that ACTUALLY landed in the rebuilt BP2 manifest as
  // announced; anything the manifest could not advertise stays un-announced so
  // the turn-boundary late reminder can still surface it.
  session.deferredAnnouncedTools = listedDeferredToolNames(
    session,
    deferredPoolToolNames(session),
    renderedDeferredManifest(session)
  );
  session.updatedAt = Date.now();
  return true;
}

/**
 * Request-boundary reconciliation (full snapshot + delta).
 * Merge currently-connected MCP tools into session.deferredLateToolCatalog (a
 * SEPARATE pool from the boot-frozen session.deferredToolCatalog) so tools from
 * servers that finished their handshake AFTER this session was created become
 * reachable through loading and direct-call discovery. Native boot metadata
 * stays unchanged; discovered schemas travel through native search history or
 * deferred request definitions, never by promotion into the eager prefix.
 * Late additions/removals are merged into one persistent typed delta. The ask
 * boundary attaches that delta to the next real prompt and acknowledges it only
 * after the provider accepts the turn; a catalog change never creates a turn.
 * Loaded definitions survive a disconnect for replay, but are not availability
 * grants. The current scoped names separately govern loading and dispatch.
 * Returns the announced names, or null when nothing was announced.
 */
export function reconcileDeferredMcpToolCatalog(session, liveMcpTools) {
  if (!session || !Array.isArray(session.tools)) return null;
  const cached = RECONCILE_STATE.get(session);
  if (cached && reconcileStateMatches(cached, reconcileStateOf(session, liveMcpTools))) return null;
  const result = reconcileDeferredMcpToolCatalogUncached(session, liveMcpTools);
  RECONCILE_STATE.set(session, reconcileStateOf(session, liveMcpTools));
  return result;
}

// Last reconciled inputs per session. A matching state means the surface that
// reconciliation would rebuild is identical, so it is skipped outright.
const RECONCILE_STATE = new WeakMap();
const LIVE_CLONES = new WeakMap();

function liveToolClone(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const generation = getMcpToolGeneration();
  const hit = LIVE_CLONES.get(tool);
  if (hit && hit.generation === generation) return hit.clone;
  const clone = immutableToolForSurface(tool);
  LIVE_CLONES.set(tool, { generation, clone });
  return clone;
}

function reconcileStateOf(session, liveMcpTools) {
  return {
    generation: getMcpToolGeneration(),
    live: Array.isArray(liveMcpTools) ? liveMcpTools.slice() : [],
    tools: session.tools.slice(),
    lateCatalog: session.deferredLateToolCatalog,
    scope: clean(session.mcpScopeId),
    cwd: clean(session.cwd),
    mode: clean(session.deferredSurfaceMode),
    providerMode: clean(session.deferredProviderMode),
    exposure: clean(session.toolExposureMode),
    provider: clean(session.provider),
    model: clean(session.model),
    disallowed: JSON.stringify(session.disallowedTools || []),
    callable: JSON.stringify(parseToolSelection(session.deferredCallableTools)),
    discovered: JSON.stringify(parseToolSelection(session.deferredDiscoveredTools)),
  };
}

function reconcileStateMatches(a, b) {
  for (const key of Object.keys(a)) {
    if (key === 'live' || key === 'tools') {
      if (a[key].length !== b[key].length || a[key].some((tool, i) => tool !== b[key][i])) return false;
    } else if (a[key] !== b[key]) return false;
  }
  return true;
}

// Tools whose schema the session itself keeps exposed: the active surface and
// the callable/discovered state. Session fields, so a compaction keeps them;
// discoveries known only from message history (native tool references) are
// not here, since compaction can remove that history.
function persistentToolSurfaceNames(session) {
  return new Set([
    ...(session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session.deferredCallableTools),
    ...parseToolSelection(session.deferredDiscoveredTools),
  ]);
}

function reconcileDeferredMcpToolCatalogUncached(session, liveMcpTools) {
  const live = filterDisallowedTools(Array.isArray(liveMcpTools) ? liveMcpTools : [], session.disallowedTools);
  const hadSnapshot = Array.isArray(session.deferredMcpToolNames);
  const previousNames = new Set(
    hadSnapshot
      ? session.deferredMcpToolNames
      : [...(session.deferredToolCatalog || []), ...(session.deferredLateToolCatalog || [])]
          .map((tool) => clean(tool?.name))
          .filter(isMcpToolName)
  );
  session.deferredMcpToolNames = [...new Set(live.map((tool) => clean(tool?.name)).filter(isMcpToolName))];
  if (fixedSurfaceSession(session)) {
    const byName = new Map();
    for (const tool of Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []) {
      const name = clean(tool?.name);
      if (name && !isMcpToolName(name)) byName.set(name, tool);
    }
    for (const tool of live) {
      const name = clean(tool?.name);
      if (name && isMcpToolName(name)) byName.set(name, liveToolClone(tool));
    }
    // A fixed surface not yet on the bridge: connect, reconnect and removal
    // update the scoped catalog only (availability follows
    // deferredMcpToolNames); nothing is announced.
    const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
    const previous = Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : [];
    session.deferredToolCatalog = catalog;
    if (previous.length !== catalog.length || previous.some((tool, index) => tool !== catalog[index])) {
      session.updatedAt = Date.now();
    }
    return null;
  }
  const lateCatalog = Array.isArray(session.deferredLateToolCatalog) ? session.deferredLateToolCatalog : [];
  // A bridge session judges a removal by the definition it had before this
  // reconciliation (a disconnected late tool leaves the late pool below).
  const knownBefore = isToolBridgeEnabled(session)
    ? new Map(deferredCatalogUnion(session).map((tool) => [clean(tool?.name), tool]))
    : null;
  const active = persistentToolSurfaceNames(session);

  const liveMcpByName = new Map();
  for (const tool of live) {
    const name = clean(tool?.name);
    if (!name || !isMcpToolName(name) || liveMcpByName.has(name)) continue;
    liveMcpByName.set(name, liveToolClone(tool));
  }

  // Rebuild the LATE pool only (boot catalog stays frozen). It holds live MCP
  // tools — INCLUDING ones whose name also exists in the boot catalog, so a
  // reconnect's fresher schema is reachable via deferredCatalogUnion (which
  // prefers the late entry). Keep an entry only while its server is still
  // connected OR the tool is already loaded, including native history-only
  // discoveries. Availability is determined by deferredMcpToolNames, not this pool.
  const nextByName = new Map();
  for (const tool of lateCatalog) {
    const name = clean(tool?.name);
    if (!name || nextByName.has(name)) continue;
    if (!liveMcpByName.has(name) && !active.has(name)) continue;
    nextByName.set(name, tool);
  }
  for (const [name, tool] of liveMcpByName) nextByName.set(name, tool);
  session.deferredLateToolCatalog = sortedCatalogByMeasuredUsage([...nextByName.values()]);

  // A promoted (active) MCP tool survives its server disconnecting; on reconnect
  // re-link the active session.tools entry to the fresh server tool so its
  // schema/handler track the live connection. Swap ONLY when the serialized
  // surface actually changed, so a steady reconnect never perturbs the tools
  // request param or its cache hash.
  for (let i = 0; i < session.tools.length; i += 1) {
    const name = clean(session.tools[i]?.name);
    if (!name || !isMcpToolName(name) || !liveMcpByName.has(name)) continue;
    const freshTool = liveMcpByName.get(name);
    if (JSON.stringify(freshTool) !== JSON.stringify(session.tools[i])) session.tools[i] = freshTool;
  }

  const nextNames = new Set(session.deferredMcpToolNames);
  const startupNames = new Set(Array.isArray(session.deferredAnnouncedTools) ? session.deferredAnnouncedTools : []);
  const added = [];
  for (const tool of liveMcpByName.values()) {
    const name = clean(tool?.name);
    if (!name || !isMcpToolName(name)) continue;
    if (previousNames.has(name) || (!hadSnapshot && (active.has(name) || startupNames.has(name)))) continue;
    if (!rosterPermits(session, tool)) continue;
    added.push({ name, description: lateAnnouncementDescription(tool?.description) });
  }
  const removed = [];
  for (const name of previousNames) {
    if (nextNames.has(name)) continue;
    if (knownBefore && !rosterPermits(session, knownBefore.get(name) || { name })) continue;
    removed.push(name);
  }
  if (!added.length && !removed.length) return null;
  mergePendingDeferredToolDelta(session, { added, removed });
  session.updatedAt = Date.now();
  return [...added.map((entry) => entry.name), ...removed];
}

/**
 * Compaction strips the delta reminder from older user turns and the boot
 * manifest in the system prompt is not rebuilt, so a late MCP tool announced
 * before a compaction would stay invisible. Re-arm it, exactly as compaction
 * re-marks the Goal reminder (markPendingGoalReminder): every currently
 * connected tool the boot manifest never listed and the session has not loaded
 * or discovered rides the next real prompt as one more delta, acknowledged
 * only once the provider accepts that turn.
 * Returns the re-armed names, or null when there are none.
 */
export function rearmLateDeferredTools(session) {
  if (!session || !Array.isArray(session.tools) || fixedSurfaceSession(session)) return null;
  if (!Array.isArray(session.deferredMcpToolNames) || !Array.isArray(session.deferredAnnouncedTools)) return null;
  // Listed in the boot manifest, or already loaded/discovered: still visible.
  const listed = new Set([...session.deferredAnnouncedTools, ...persistentToolSurfaceNames(session)]);
  const connected = new Set(session.deferredMcpToolNames);
  const added = [];
  for (const tool of Array.isArray(session.deferredLateToolCatalog) ? session.deferredLateToolCatalog : []) {
    const name = clean(tool?.name);
    if (!name || !connected.has(name) || listed.has(name) || !rosterPermits(session, tool)) continue;
    added.push({ name, description: lateAnnouncementDescription(tool?.description) });
  }
  if (!added.length) return null;
  mergePendingDeferredToolDelta(session, { added });
  return added.map((entry) => entry.name);
}

export function scopedMcpToolsFor(session, config = null) {
  return filterMcpToolsForSession(getMcpTools(session?.mcpScopeId), session?.cwd || null, config);
}

export function refreshDeferredMcpToolCatalog(session, config = null) {
  if (!session?.deferredProviderMode) return null;
  return reconcileDeferredMcpToolCatalog(session, scopedMcpToolsFor(session, config));
}

export function selectDeferredTools(session, names, mode, { exact = false } = {}) {
  // Resolve against the union of the boot-frozen catalog and the late-connected
  // MCP catalog so load_tool can load a late tool. Native providers register it
  // independently; canonical fallback providers already expose the full array.
  const catalog = resolvableCatalog(session);
  const surfaceActive = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const active = new Set([...surfaceActive, ...parseToolSelection(session?.deferredCallableTools)]);
  const native = session?.deferredProviderMode === 'native' || session?.deferredNativeTools === true;
  const discovered = new Set(Array.isArray(session?.deferredDiscoveredTools) ? session.deferredDiscoveredTools : []);
  // Bridge sessions keep a fixed surface: deferred tools are described and
  // run through the bridge, never appended to session.tools.
  const bridge = isToolBridgeEnabled(session);
  const activateOnSurface = !native;
  const byName = new Map();
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (!name) continue;
    byName.set(name, tool);
    byName.set(name.toLowerCase(), tool);
  }
  const added = [];
  const already = [];
  const blocked = [];
  const missing = [];
  const requested = exact
    ? names
    : expandSelectionNames(names).flatMap((raw) => {
        const key = clean(raw);
        if (byName.has(key) || byName.has(key.toLowerCase())) return [key];
        const members = mcpServerSelection(catalog, key).map((tool) => clean(tool?.name));
        return members.length ? members : [key];
      });
  for (const rawName of new Set(requested)) {
    const requestedName = clean(rawName);
    const tool = byName.get(requestedName) || byName.get(requestedName.toLowerCase());
    const name = clean(tool?.name);
    if (!tool || !isDeferredToolAvailable(session, name)) {
      missing.push(requestedName);
      continue;
    }
    // A tool this route never sends (schema rejected) is not loaded and not
    // listed as active; the reason says why.
    const routeExclusion = bridge ? null : routeToolExclusionReason(session, tool);
    if (routeExclusion) {
      blocked.push({ name, reason: routeExclusion });
      continue;
    }
    if (mode === 'readonly' && !isReadonlySelectable(tool)) {
      blocked.push({ name, reason: 'readonly mode' });
      continue;
    }
    if (bridge || active.has(name) || (!activateOnSurface && discovered.has(name))) {
      already.push(name);
      continue;
    }
    if (activateOnSurface) {
      session.tools.push(tool);
      active.add(name);
      discovered.delete(name);
    } else {
      discovered.add(name);
      active.add(name);
    }
    added.push(name);
  }
  if (bridge) return { added, already, blocked, missing, native };
  if (native) {
    session.deferredCallableTools = sortedNamesByMeasuredUsage(active);
    session.deferredDiscoveredTools = sortedNamesByMeasuredUsage([...discovered]);
    session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  } else {
    setDeferredToolState(session, active);
  }
  return { added, already, blocked, missing, native };
}

// Split live MCP servers into "still connecting" (pending) and "failed" so the
// loader can tell the model to retry next turn instead of treating a missing
// tool as a permanent zero result. `mcpStatus` is a getter plumbed from the
// runtime; absent in unit tests, where these lists are simply empty.
function pendingAndFailedMcpServers(mcpStatus) {
  const empty = { pending: [], failed: [] };
  let status = null;
  try {
    status = typeof mcpStatus === 'function' ? mcpStatus() : mcpStatus;
  } catch {
    return empty;
  }
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  const pending = [];
  const failed = [];
  for (const row of servers) {
    const name = clean(row?.name);
    if (!name) continue;
    if (row?.status === 'disconnected') pending.push(name);
    else if (row?.status === 'failed') failed.push(name);
  }
  return { pending: [...new Set(pending)].sort(), failed: [...new Set(failed)].sort() };
}

/**
 * The deferred catalog union, or the session's own tools when nothing is
 * deferred — either way only what the session's policy lets it execute.
 */
function resolvableCatalog(session) {
  const union = deferredCatalogUnion(session);
  let tools = union;
  if (!union.length) tools = Array.isArray(session?.tools) ? session.tools : [];
  return filterSessionToolPolicy(tools, session);
}

// Pure loader. Input is exact deferred-tool names/aliases; output reports
// loaded / already-active / missing / blocked tools PLUS pending/failed MCP
// servers. No listing, no ranking, no substring filter. `options.mcpStatus` is
// the runtime getter for per-server status.
export function renderToolSearch(args = {}, session, mode = 'full', options = {}) {
  // Bridge mode: load_tool describes (bounded, paged) and never loads.
  if (isToolBridgeEnabled(session)) return formatBridgeResult(describeBridgeTools(session, args, { mode }));
  const catalog = resolvableCatalog(session);
  const requestedNames = parseToolSelection(args.names);
  const { pending: pendingMcpServers, failed: failedMcpServers } = pendingAndFailedMcpServers(options?.mcpStatus);
  const mcpFields = {
    ...(pendingMcpServers.length ? { pendingMcpServers } : {}),
    ...(failedMcpServers.length ? { failedMcpServers } : {}),
  };

  if (!requestedNames.length) {
    const strayQuery = clean(args.query || args.q || args.text);
    return JSON.stringify(
      {
        error: strayQuery
          ? `load_tool is a loader, not a search: "${strayQuery}" is not an exact tool name. Pass names:["exact_tool_name", ...] (deferred tool names/aliases). No keyword search.`
          : 'load_tool requires names:["exact_tool_name", ...] (deferred tool names/aliases).',
        loaded: [],
        alreadyActive: [],
        missing: [],
        ...mcpFields,
        activeTools: sortedNamesByMeasuredUsage(
          permittedNames(session, (session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean)).filter(
            sentOnRoute(session, catalog)
          )
        ),
        discoveredTools: sortedNamesByMeasuredUsage(permittedNames(session, session?.deferredDiscoveredTools)),
      },
      null,
      2
    );
  }

  // Native loads update only the callable registry and provider-native history
  // payload. Canonical fallback providers already carry the complete array.
  const toolSelection = selectDeferredTools(session, requestedNames, mode);
  const nextActiveNames = new Set([
    ...(session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session?.deferredCallableTools),
  ]);
  const loaded = toolSelection.added || [];
  const alreadyActive = toolSelection.already || [];
  const missing = toolSelection.missing || [];
  const blocked = toolSelection.blocked || [];
  // Native discovery is history-driven: an explicit re-selection must emit
  // the tool reference/spec again even when the callable registry already has
  // the name. Other agent runtimes treat repeated selection as a
  // harmless reference refresh; suppressing it leaves declaration-gated
  // harnesses with "already active" text but no callable schema.
  const nativeToolSearchBase = toolSelection.native
    ? toolSearchNativePayload(catalog, [...loaded, ...alreadyActive], session?.provider) || {
        provider: clean(session?.provider).toLowerCase(),
        toolReferences: [],
        openaiTools: [],
        summary: '',
      }
    : null;
  const alreadyActiveSchemas = toolSelection.native ? [] : activeToolSchemas(catalog, session, alreadyActive);
  const nativeSummary = [
    ...(loaded.length ? [`Loaded deferred tools: ${loaded.join(', ')}`] : []),
    ...(alreadyActive.length ? [`Already active: ${alreadyActive.join(', ')}`] : []),
  ].join('\n');
  const nativeToolSearch = nativeToolSearchBase
    ? { ...nativeToolSearchBase, summary: nativeSummary || nativeToolSearchBase.summary }
    : null;
  const notes = [];
  if (missing.length && pendingMcpServers.length) {
    notes.push('Some requested names may belong to an MCP server still connecting — retry next turn.');
  }
  if (missing.length && failedMcpServers.length) {
    notes.push('Some requested names may belong to a failed MCP server; those tools are unavailable.');
  }
  return JSON.stringify(
    {
      // `selected` retained for back-compat consumers (mode is always 'select').
      selected: { mode: 'select', tools: toolSelection },
      ...(nativeToolSearch ? { nativeToolSearch } : {}),
      loaded,
      alreadyActive,
      ...(alreadyActiveSchemas.length ? { alreadyActiveSchemas } : {}),
      missing,
      ...(blocked.length ? { blocked } : {}),
      ...mcpFields,
      activeTools: sortedNamesByMeasuredUsage(
        permittedNames(session, [...nextActiveNames])
          .filter((name) => isDeferredToolAvailable(session, name))
          .filter(sentOnRoute(session, catalog))
      ),
      discoveredTools: sortedNamesByMeasuredUsage(permittedNames(session, session?.deferredDiscoveredTools)),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    },
    null,
    2
  );
}
