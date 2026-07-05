// Deferred-tool catalog: measured-usage ordering, kind/bucket classification,
// tool_search ranking + auto-selection, and the session tool-surface
// application/selection logic. Pure module (session objects passed in).
import { clean } from './session-text.mjs';
import { estimateToolSchemaTokens } from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { applyInitialDeferredToolManifestToBp1 } from '../runtime/agent/orchestrator/context/collect.mjs';
import { getMcpServerInstructionsMap } from '../runtime/agent/orchestrator/mcp/client.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';

export const MEASURED_TOOL_USAGE = Object.freeze({
  read: 710,
  code_graph: 520,
  grep: 500,
  find: 480,
  glob: 460,
  list: 430,
  apply_patch: 400,
  explore: 360,
  agent: 330,
  shell: 81,
  cwd: 2,
  recall: 2,
  search: 2,
  web_fetch: 2,
});
const MEASURED_TOOL_ORDER = Object.freeze(Object.keys(MEASURED_TOOL_USAGE));
export const DEFERRED_DEFAULT_FULL_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'find',
  'glob',
  'list',
  'explore',
  'apply_patch',
  'Skill',
  'tool_search',
]);
export const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'find',
  'glob',
  'list',
  'explore',
  'Skill',
  'tool_search',
]);
export const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  'read',
  'code_graph',
  'grep',
  'find',
  'glob',
  'list',
  'shell',
  'task',
  'explore',
  'apply_patch',
  'agent',
  'recall',
  'search',
  'web_fetch',
  'cwd',
    'session_manage',
  'Skill',
  'tool_search',
]);
const READONLY_TOOL_NAMES = new Set([
  'read',
  'list',
  'grep',
  'find',
  'glob',
  'code_graph',
  'search',
  'web_fetch',
  'recall',
  'memory',
  'fetch',
  'Skill',
]);
const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'find', 'glob'],
  search: ['search', 'web_fetch'],
  web: ['web_fetch', 'search'],
  memory: ['memory', 'recall'],
  channels: ['reply', 'fetch'],
  discord: ['reply', 'fetch'],
  explore: ['explore'],
  discovery: ['explore'],
  agent: ['agent'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
};

export function toolKind(tool) {
  const name = clean(tool?.name);
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('skill:') || tool?.annotations?.mixdogKind === 'skill') return 'skill';
  if (name === 'Skill' || name.startsWith('skill_') || name === 'skills_list' || name === 'skill_view') return 'skill';
  if (tool?.annotations?.agentHidden) return 'control';
  if (['apply_patch', 'shell'].includes(name)) return 'mutation';
  return 'tool';
}

export function toolSchemaBucket(tool) {
  const name = clean(tool?.name);
  const kind = toolKind(tool);
  if (kind === 'mcp') return 'mcp';
  if (kind === 'skill') return 'skills';
  if (name === 'memory' || name === 'recall' || name.includes('memory')) return 'memory';
  if (name === 'search' || name === 'web_fetch') return 'web';
  if (['read', 'grep', 'find', 'glob', 'list', 'code_graph', 'explore'].includes(name)) return 'code';
  if (['shell', 'apply_patch'].includes(name)) return 'mutation';
  if (name === 'agent' || name === 'delegate') return 'agents';
  if (name.includes('channel') || name.includes('discord') || name.includes('webhook')) return 'channels';
  if (name.includes('provider') || name === 'tool_search' || name === 'cwd') return 'setup';
  return 'other';
}

export function estimateToolSchemaBreakdown(tools) {
  const out = {};
  for (const tool of Array.isArray(tools) ? tools : []) {
    const bucket = toolSchemaBucket(tool);
    const row = out[bucket] || { count: 0, tokens: 0 };
    row.count += 1;
    row.tokens += estimateToolSchemaTokens([tool]);
    out[bucket] = row;
  }
  return out;
}

export function measuredToolUsage(name) {
  return MEASURED_TOOL_USAGE[clean(name)] || 0;
}

export function parseToolSelection(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (value && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
    return [...value].map(clean).filter(Boolean);
  }
  return String(value || '').replace(/^select\s*:/i, '')
    .split(/[,\s]+/)
    .map(clean)
    .filter(Boolean);
}

export function parseToolSearchQuerySelection(query) {
  const match = clean(query).match(/^select\s*:\s*(.+)$/i);
  return match ? parseToolSelection(match[1]) : [];
}

function measuredToolRank(name) {
  const index = MEASURED_TOOL_ORDER.indexOf(clean(name));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortedCatalogByMeasuredUsage(catalog) {
  return (catalog || [])
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => {
      const au = measuredToolUsage(a.tool?.name);
      const bu = measuredToolUsage(b.tool?.name);
      if (bu !== au) return bu - au;
      const ar = measuredToolRank(a.tool?.name);
      const br = measuredToolRank(b.tool?.name);
      if (ar !== br) return ar - br;
      return a.index - b.index;
    })
    .map((entry) => entry.tool);
}

function activeToolForSurface(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  return JSON.parse(JSON.stringify(tool));
}

function deferredProviderMode(provider) {
  const p = clean(provider).toLowerCase();
  if (p === 'gemini') return 'full';
  if (p === 'anthropic' || p === 'anthropic-oauth'
    || p === 'openai' || p === 'openai-oauth'
    || p === 'xai' || p === 'grok-oauth') {
    return 'native';
  }
  return 'legacy';
}

export function filterDisallowedTools(tools, disallowed = []) {
  if (!Array.isArray(disallowed) || disallowed.length === 0) return tools;
  const deny = new Set(disallowed.map((name) => clean(name)).filter(Boolean));
  if (deny.size === 0) return tools;
  return (tools || []).filter((tool) => !deny.has(clean(tool?.name)));
}

export function sortedNamesByMeasuredUsage(names) {
  return [...(names || [])].sort((a, b) => {
    const au = measuredToolUsage(a);
    const bu = measuredToolUsage(b);
    if (bu !== au) return bu - au;
    const ar = measuredToolRank(a);
    const br = measuredToolRank(b);
    if (ar !== br) return ar - br;
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

function toolSearchNativePayload(catalog, names, provider = '') {
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
    toolReferences: refs,
    openaiTools: tools,
    summary: `Loaded deferred tools: ${refs.join(', ')}`,
  };
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

export function deferredPoolToolNames(session) {
  if (!session || session.deferredProviderMode === 'full') return [];
  const catalog = Array.isArray(session.deferredToolCatalog)
    ? session.deferredToolCatalog
    : [];
  const active = new Set((session.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const out = [];
  for (const tool of catalog) {
    const name = clean(tool?.name);
    if (name && !active.has(name)) out.push(name);
  }
  return sortedNamesByMeasuredUsage(out);
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
  for (const tool of [...session.tools, ...(extraTools || [])]) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, activeToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  const storedNames = providerMode === 'native' ? [] : storedDeferredToolNames(session);
  let selectedNames = providerMode === 'full'
    ? sortedNamesByMeasuredUsage(catalog.map((tool) => clean(tool?.name)).filter(Boolean))
    : [];
  if (providerMode !== 'full') {
    selectedNames = storedNames.length ? canonicalDeferredToolNames(catalog, storedNames) : [];
    if (!selectedNames.length || providerMode === 'native') selectedNames = sortedNamesByMeasuredUsage(defaultNames);
  }
  const selected = new Set(selectedNames);
  session.deferredToolCatalog = catalog;
  session.deferredToolUsage = MEASURED_TOOL_USAGE;
  session.deferredDefaultTools = sortedNamesByMeasuredUsage(defaultNames);
  session.deferredProviderMode = providerMode;
  session.deferredNativeTools = providerMode === 'native';
  session.tools.length = 0;
  const active = [];
  for (const tool of catalog) {
    if (!selected.has(clean(tool?.name))) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    session.tools.push(tool);
    active.push(clean(tool?.name));
  }
  if (providerMode === 'native') {
    const discovered = canonicalDeferredToolNames(catalog, session.deferredDiscoveredTools || []);
    session.deferredSelectedTools = active;
    session.deferredDiscoveredTools = discovered.filter((name) => !selected.has(name));
  } else {
    setDeferredToolState(session, active);
  }
  if (!session.deferredToolBp1Applied && session.messages?.some((m) => m?.role === 'system')) {
    if (!session.mcpServerInstructions || typeof session.mcpServerInstructions !== 'object') {
      session.mcpServerInstructions = getMcpServerInstructionsMap();
    }
    applyInitialDeferredToolManifestToBp1(session, deferredPoolToolNames(session));
  }
  return session;
}

export function selectDeferredTools(session, names, mode, options = {}) {
  const promoteToActive = options?.promoteToActive === true;
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const active = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const native = session?.deferredProviderMode === 'native' || session?.deferredNativeTools === true;
  const discovered = new Set(Array.isArray(session?.deferredDiscoveredTools) ? session.deferredDiscoveredTools : []);
  const activateOnSurface = !native || promoteToActive;
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
  for (const rawName of expandSelectionNames(names)) {
    const requestedName = clean(rawName);
    const tool = byName.get(requestedName) || byName.get(requestedName.toLowerCase());
    const name = clean(tool?.name);
    if (!tool) {
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
    }
    added.push(name);
  }
  if (native) {
    session.deferredDiscoveredTools = sortedNamesByMeasuredUsage(
      [...discovered].filter((toolName) => !active.has(toolName)),
    );
    session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  } else {
    setDeferredToolState(session, active);
  }
  return { added, already, blocked, missing, native };
}

export function renderToolSearch(args = {}, session, mode = 'full') {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const rawQuery = clean(args.query);
  const explicitSelectedNames = parseToolSelection(args.select);
  const querySelectedNames = explicitSelectedNames.length ? [] : parseToolSearchQuerySelection(rawQuery);
  const forcedSelectedNames = explicitSelectedNames.length ? explicitSelectedNames : querySelectedNames;
  const query = querySelectedNames.length ? '' : rawQuery.toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  // Explicit loader only: select names/aliases (or query "select:a,b") load
  // deferred tools. A plain query is a case-insensitive substring filter over
  // name+description for listing — it never loads. No scores, no ranking, no
  // category auto-load: deferred tools are called directly (they auto-promote
  // via deferred call-through) and are advertised in the system-prompt manifest.
  const toolSelection = forcedSelectedNames.length
    ? selectDeferredTools(session, forcedSelectedNames, mode)
    : null;
  const selectionMode = forcedSelectedNames.length ? 'select' : null;
  const nextActiveNames = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const rows = catalog.map((tool) => toolRow(tool, nextActiveNames)).filter((row) => row.name);
  const matches = query ? rows.filter((row) => toolSearchMatches(row, query)) : rows;
  const selected = toolSelection
    ? {
        mode: selectionMode,
        tools: toolSelection,
      }
    : null;
  const nativeToolSearch = toolSelection?.native
    ? toolSearchNativePayload(catalog, [...new Set([...toolSelection.added, ...(toolSelection.already || [])])], session?.provider)
    : null;
  return JSON.stringify({
    selected,
    ...(nativeToolSearch ? { nativeToolSearch } : {}),
    totalMatches: matches.length,
    matches: matches.slice(0, limit),
    activeTools: sortedNamesByMeasuredUsage(nextActiveNames),
    discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    note: 'Deferred tools listed in the system-prompt manifest can be called directly by name (they auto-load on first call). This tool only lists (query = case-insensitive substring over name+description; never loads) or loads exact tools when you pass select names/aliases or query "select:a,b".',
  }, null, 2);
}
