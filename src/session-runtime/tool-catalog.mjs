// Deferred-tool catalog: measured-usage ordering, kind/bucket classification,
// tool_search ranking + auto-selection, and the session tool-surface
// application/selection logic. Pure module (session objects passed in).
import { clean } from './session-text.mjs';
import { mergePendingDeferredToolDelta } from './deferred-tool-delta.mjs';
import {
  applyInitialDeferredToolManifestToBp2,
  stripDeferredToolManifestBlock,
} from '../runtime/agent/orchestrator/context/collect.mjs';
import { getMcpServerInstructionsMap, getMcpTools } from '../runtime/agent/orchestrator/mcp/client.mjs';
import { filterMcpToolsForSession } from './extension-scopes.mjs';
import { isDeferredToolAvailable } from './deferred-tool-availability.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  DEFERRED_SELECT_ALIASES,
  MEASURED_TOOL_USAGE,
  READONLY_TOOL_NAMES,
} from './tool-catalog-data.mjs';
import { toolKind, measuredToolUsage, parseToolSelection, routeToolRank, sortedCatalogByMeasuredUsage, activeToolForSurface, deferredProviderMode, nativeProviderFamily } from './tool-catalog-schema.mjs';
import { filterModelEditTools } from '../runtime/shared/edit-tool-dialect.mjs';
export { toolKind, toolSchemaBucket, estimateToolSchemaBreakdown, measuredToolUsage, parseToolSelection, sortedCatalogByMeasuredUsage } from './tool-catalog-schema.mjs';
export { snapshotProviderRequestTools } from './provider-request-snapshot.mjs';
export {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  MEASURED_TOOL_USAGE,
} from './tool-catalog-data.mjs';


export function filterDisallowedTools(tools, disallowed = []) {
  if (!Array.isArray(disallowed) || disallowed.length === 0) return tools;
  const deny = new Set(disallowed.map((name) => clean(name)).filter(Boolean));
  if (deny.size === 0) return tools;
  return (tools || []).filter((tool) => !deny.has(clean(tool?.name)));
}

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
  if (providerSupportsResponsesCustomTools(provider) && isResponsesFreeformTool(tool)) return toResponsesCustomTool(tool);
  return {
    type: 'function',
    name: clean(tool?.name),
    description: clean(tool?.description),
    defer_loading: true,
    parameters: tool?.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
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
      specs.push({
        name,
        description: clean(tool?.description),
        parameters: tool?.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
      });
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
  if (!session || session.deferredProviderMode === 'full'
    || session.deferredProviderMode === 'manifest'
    || session.deferredProviderMode === 'canonical') return [];
  const catalog = Array.isArray(session.deferredToolCatalog)
    ? session.deferredToolCatalog
    : [];
  const active = new Set([
    ...(session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session.deferredCallableTools),
  ]);
  const out = [];
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (name && !active.has(name)) out.push(name);
  }
  return sortedNamesByMeasuredUsage(out);
}

// Definition history combines the boot catalog with refreshed MCP definitions.
// Selection separately checks current availability. Native request snapshots
// expose only discovered definitions; the union never eagerly exposes the pool.
export function deferredCatalogUnion(session) {
  const boot = filterDisallowedTools(
    Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : [],
    session?.disallowedTools,
  );
  const late = filterDisallowedTools(
    Array.isArray(session?.deferredLateToolCatalog) ? session.deferredLateToolCatalog : [],
    session?.disallowedTools,
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
  const providerMode = deferredProviderMode(options.provider || session.provider);
  const byName = new Map();
  const candidates = filterDisallowedTools(
    filterModelEditTools(
      [...session.tools, ...(extraTools || [])],
      options.model || session.model,
    ),
    [...(session.disallowedTools || []), ...(options.disallowed || [])],
  );
  for (const tool of candidates) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  const storedNames = providerMode === 'native' ? [] : storedDeferredToolNames(session);
  let selectedNames = providerMode === 'full' || providerMode === 'manifest' || providerMode === 'canonical'
    ? sortedNamesByMeasuredUsage(catalog.map((tool) => clean(tool?.name)).filter(Boolean))
    : [];
  if (!['full', 'manifest', 'canonical'].includes(providerMode)) {
    selectedNames = storedNames.length ? canonicalDeferredToolNames(catalog, storedNames) : [];
    if (!selectedNames.length || providerMode === 'native') selectedNames = sortedNamesByMeasuredUsage(defaultNames);
  }
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
  session.deferredCallableTools = sortedNamesByMeasuredUsage(active);
  if (providerMode === 'native') {
    const discovered = canonicalDeferredToolNames(catalog, session.deferredDiscoveredTools || []);
    session.deferredSelectedTools = active;
    session.deferredDiscoveredTools = discovered.filter((name) => !selected.has(name));
  } else {
    setDeferredToolState(session, active);
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
  const previousMode = session.deferredProviderMode;
  const previousFamily = nativeProviderFamily(session.provider);
  const nextFamily = nativeProviderFamily(provider);
  const preserveNativeState = previousFamily && previousFamily === nextFamily;
  const discovered = preserveNativeState
    ? canonicalDeferredToolNames(deferredCatalogUnion(session), session.deferredDiscoveredTools || [])
    : [];
  const catalog = deferredCatalogUnion(session).slice();
  session.deferredDiscoveredTools = discovered;
  applyDeferredToolSurface(
    session,
    session.deferredSurfaceMode || 'lead',
    catalog,
    { provider },
  );
  if (session.deferredProviderMode === 'native' && discovered.length) {
    session.deferredDiscoveredTools = discovered;
    session.deferredCallableTools = sortedNamesByMeasuredUsage(new Set([
      ...(session.deferredCallableTools || []),
      ...discovered,
    ]));
    session.deferredSelectedTools = session.deferredCallableTools.slice();
  }
  if (previousMode && previousMode !== session.deferredProviderMode) {
    if (session.deferredProviderMode === 'native') {
      session.mcpServerInstructions = getMcpServerInstructionsMap(session.mcpScopeId);
      applyInitialDeferredToolManifestToBp2(session, deferredPoolToolNames(session), { rebuild: true });
      const rendered = session.messages?.find((message) => (
        message?.role === 'system'
        && typeof message.content === 'string'
        && message.content.includes('<available-deferred-tools>')
      ))?.content;
      session.deferredAnnouncedTools = deferredPoolToolNames(session)
        .filter((name) => typeof rendered === 'string' && rendered.includes(name));
    } else if (previousMode === 'native') {
      for (const system of session.messages?.filter((message) => message?.role === 'system') || []) {
        if (typeof system.content === 'string') system.content = stripDeferredToolManifestBlock(system.content);
      }
      session.messages = session.messages.filter((message) => (
        message?.role !== 'system' || String(message.content || '').trim()
      ));
      session.deferredAnnouncedTools = [];
      session.deferredToolBp2Applied = true;
      delete session.deferredToolBp1Applied;
    }
  }
  return session;
}

// FIRST-TURN deferred-surface refresh (turn-time deferred manifest).
// An MCP server may finish its handshake BETWEEN session-create and the first
// user send. Fold those LIVE MCP tools into the boot deferred catalog + the
// provider-visible first-turn surface. Native providers rebuild the initial BP2
// <available-deferred-tools> manifest IN PLACE and pre-mark names announced.
// Manifest/canonical providers update their active fixed surface directly; the
// canonical path never emits a deferred manifest or late reminder. Fully sync
// and idempotent: no genuinely-new MCP name => no-op / no mutation.
export function refreshInitialDeferredMcpSurface(session, liveMcpTools) {
  if (!session || !Array.isArray(session.messages)) return false;
  if (session.deferredProviderMode === 'full') return false;
  const isMcp = (name) => typeof name === 'string' && name.startsWith('mcp__');
  const byName = new Map();
  for (const tool of Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []) {
    const name = clean(tool?.name);
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  let added = false;
  for (const tool of Array.isArray(liveMcpTools) ? liveMcpTools : []) {
    const name = clean(tool?.name);
    if (!name || !isMcp(name) || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
    added = true;
  }
  if (!added) return false;
  session.deferredToolCatalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  if (session.deferredProviderMode === 'manifest' || session.deferredProviderMode === 'canonical') {
    const next = session.deferredToolCatalog.filter((tool) => (
      session.deferredSurfaceMode !== 'readonly' || isReadonlySelectable(tool)
    ));
    session.tools.splice(0, session.tools.length, ...next);
    session.deferredCallableTools = next.map((tool) => clean(tool?.name)).filter(Boolean);
    if (session.deferredProviderMode === 'canonical') {
      setDeferredToolState(session, session.deferredCallableTools);
    }
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
  const rendered = (() => {
    const sys = session.messages.find((m) => (
      m?.role === 'system'
      && typeof m.content === 'string'
      && m.content.includes('<available-deferred-tools>')
    ));
    return typeof sys?.content === 'string' ? sys.content : '';
  })();
  session.deferredAnnouncedTools = deferredPoolToolNames(session).filter((name) => rendered.includes(name));
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
  const isMcp = (name) => typeof name === 'string' && name.startsWith('mcp__');
  const live = filterDisallowedTools(
    Array.isArray(liveMcpTools) ? liveMcpTools : [], session.disallowedTools,
  );
  const hadSnapshot = Array.isArray(session.deferredMcpToolNames);
  const previousNames = new Set(hadSnapshot ? session.deferredMcpToolNames : [
    ...(session.deferredToolCatalog || []),
    ...(session.deferredLateToolCatalog || []),
  ].map((tool) => clean(tool?.name)).filter(isMcp));
  session.deferredMcpToolNames = [...new Set(live.map((tool) => clean(tool?.name)).filter(isMcp))];
  if (['full', 'manifest', 'canonical'].includes(session.deferredProviderMode)) {
    const byName = new Map();
    for (const tool of Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog : []) {
      const name = clean(tool?.name);
      if (name && !isMcp(name)) byName.set(name, tool);
    }
    for (const tool of live) {
      const name = clean(tool?.name);
      if (name && isMcp(name)) byName.set(name, activeToolForSurface(tool));
    }
    const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
    const next = catalog.filter((tool) => (
      session.deferredSurfaceMode !== 'readonly' || isReadonlySelectable(tool)
    ));
    const before = JSON.stringify((session.tools || []).map((tool) => activeToolForSurface(tool)));
    const after = JSON.stringify(next);
    session.deferredToolCatalog = catalog;
    session.tools.splice(0, session.tools.length, ...next);
    session.deferredCallableTools = next.map((tool) => clean(tool?.name)).filter(Boolean);
    if (before !== after) session.updatedAt = Date.now();
    return before === after ? null : session.deferredCallableTools;
  }
  const lateCatalog = Array.isArray(session.deferredLateToolCatalog) ? session.deferredLateToolCatalog : [];
  const active = new Set([
    ...(session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean),
    ...parseToolSelection(session.deferredCallableTools),
    ...parseToolSelection(session.deferredDiscoveredTools),
  ]);

  const liveMcpByName = new Map();
  for (const tool of live) {
    const name = clean(tool?.name);
    if (!name || !isMcp(name) || liveMcpByName.has(name)) continue;
    liveMcpByName.set(name, activeToolForSurface(tool));
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
  if (Array.isArray(session.tools)) {
    for (let i = 0; i < session.tools.length; i += 1) {
      const name = clean(session.tools[i]?.name);
      if (!name || !isMcp(name) || !liveMcpByName.has(name)) continue;
      const freshTool = liveMcpByName.get(name);
      if (JSON.stringify(freshTool) !== JSON.stringify(session.tools[i])) session.tools[i] = freshTool;
    }
  }

  const nextNames = new Set(session.deferredMcpToolNames);
  const startupNames = new Set(
    Array.isArray(session.deferredAnnouncedTools) ? session.deferredAnnouncedTools : [],
  );
  const added = [];
  for (const tool of liveMcpByName.values()) {
    const name = clean(tool?.name);
    if (!name || !isMcp(name)) continue;
    if (previousNames.has(name) || (!hadSnapshot && (active.has(name) || startupNames.has(name)))) continue;
    added.push({ name, description: lateAnnouncementDescription(tool?.description) });
  }
  const removed = [];
  for (const name of previousNames) {
    if (nextNames.has(name)) continue;
    removed.push(name);
  }
  if (!added.length && !removed.length) return null;
  mergePendingDeferredToolDelta(session, { added, removed });
  session.updatedAt = Date.now();
  return [...added.map((entry) => entry.name), ...removed];
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
  const union = deferredCatalogUnion(session);
  const catalog = union.length
    ? union
    : filterDisallowedTools(Array.isArray(session?.tools) ? session.tools : [], session?.disallowedTools);
  const surfaceActive = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const active = new Set([...surfaceActive, ...parseToolSelection(session?.deferredCallableTools)]);
  const native = session?.deferredProviderMode === 'native' || session?.deferredNativeTools === true;
  const discovered = new Set(Array.isArray(session?.deferredDiscoveredTools) ? session.deferredDiscoveredTools : []);
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
  for (const rawName of exact ? [...new Set(names)] : expandSelectionNames(names)) {
    const requestedName = clean(rawName);
    const tool = byName.get(requestedName) || byName.get(requestedName.toLowerCase());
    const name = clean(tool?.name);
    if (!tool || !isDeferredToolAvailable(session, name)) {
      missing.push(requestedName);
      continue;
    }
    if (mode === 'readonly' && !isReadonlySelectable(tool)) {
      blocked.push({ name, reason: 'readonly mode' });
      continue;
    }
    if (active.has(name) || (!activateOnSurface && discovered.has(name))) {
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
  if (native) {
    session.deferredCallableTools = sortedNamesByMeasuredUsage(active);
    session.deferredDiscoveredTools = sortedNamesByMeasuredUsage(
      [...discovered],
    );
    session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  } else {
    setDeferredToolState(session, active);
  }
  return { added, already, blocked, missing, native };
}

// Collect the exact deferred-tool names requested by the loader.
function parseLoadToolNames(args = {}) {
  return parseToolSelection(args.names);
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

// Pure loader (formerly a keyword search). Input is exact deferred-tool
// names/aliases; output reports loaded / already-active / missing / blocked
// tools PLUS pending/failed MCP servers. No listing, no ranking, no substring
// filter. `options.mcpStatus` is the runtime getter for per-server status.
export function renderToolSearch(args = {}, session, mode = 'full', options = {}) {
  const unionCatalog = deferredCatalogUnion(session);
  const catalog = unionCatalog.length
    ? unionCatalog
    : filterDisallowedTools(Array.isArray(session?.tools) ? session.tools : [], session?.disallowedTools);
  const requestedNames = parseLoadToolNames(args);
  const { pending: pendingMcpServers, failed: failedMcpServers } = pendingAndFailedMcpServers(options?.mcpStatus);
  const mcpFields = {
    ...(pendingMcpServers.length ? { pendingMcpServers } : {}),
    ...(failedMcpServers.length ? { failedMcpServers } : {}),
  };

  if (!requestedNames.length) {
    const strayQuery = clean(args.query || args.q || args.text);
    return JSON.stringify({
      error: strayQuery
        ? `load_tool is a loader, not a search: "${strayQuery}" is not an exact tool name. Pass names:["exact_tool_name", ...] (deferred tool names/aliases). No keyword search.`
        : 'load_tool requires names:["exact_tool_name", ...] (deferred tool names/aliases).',
      loaded: [],
      alreadyActive: [],
      missing: [],
      ...mcpFields,
      activeTools: sortedNamesByMeasuredUsage((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean)),
      discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    }, null, 2);
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
    ? (toolSearchNativePayload(catalog, [...loaded, ...alreadyActive], session?.provider) || {
        provider: clean(session?.provider).toLowerCase(),
        toolReferences: [],
        openaiTools: [],
        summary: '',
      })
    : null;
  const alreadyActiveSchemas = activeToolSchemas(catalog, session, alreadyActive);
  const nativeSummary = [
    ...(loaded.length ? [`Loaded deferred tools: ${loaded.join(', ')}`] : []),
    ...(alreadyActive.length ? [`Already active: ${alreadyActive.join(', ')}`] : []),
    // The native path replaces the whole JSON result with this summary
    // (tool-batch), so an already-active tool's schema has to travel here or
    // the caller keeps guessing its parameters.
    ...(alreadyActiveSchemas.length ? [`Already-active schemas: ${JSON.stringify(alreadyActiveSchemas)}`] : []),
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
  return JSON.stringify({
    // `selected` retained for back-compat consumers (mode is always 'select').
    selected: { mode: 'select', tools: toolSelection },
    ...(nativeToolSearch ? { nativeToolSearch } : {}),
    loaded,
    alreadyActive,
    ...(alreadyActiveSchemas.length ? { alreadyActiveSchemas } : {}),
    missing,
    ...(blocked.length ? { blocked } : {}),
    ...mcpFields,
    activeTools: sortedNamesByMeasuredUsage([...nextActiveNames].filter((name) => isDeferredToolAvailable(session, name))),
    discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  }, null, 2);
}
