// Tool schema/kind classification + measured-usage ordering, extracted from tool-catalog.mjs.
import { clean, LATE_TOOL_ANNOUNCEMENT_SENTINEL } from './session-text.mjs';
import { estimateToolSchemaTokens, toolSchemaSignature } from '../runtime/agent/orchestrator/session/context-utils.mjs';
import {
  applyInitialDeferredToolManifestToBp1,
  buildDeferredToolManifest,
  stripDeferredToolManifestBlock,
} from '../runtime/agent/orchestrator/context/collect.mjs';
import { getMcpServerInstructionsMap } from '../runtime/agent/orchestrator/mcp/client.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import {
  finalizeProviderRequestTools,
  providerNativeToolPrefixCount,
} from './provider-request-tools.mjs';
import {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  DEFERRED_SELECT_ALIASES,
  MEASURED_TOOL_ORDER,
  MEASURED_TOOL_USAGE,
  READONLY_TOOL_NAMES,
} from './tool-catalog-data.mjs';

export const toolSchemaBreakdownMemo = new WeakMap();

export function sameToolSchemaEntries(cached, tools) {
  if (!cached || cached.entries.length !== tools.length) return false;
  const nativePrefixCount = providerNativeToolPrefixCount(tools);
  for (let index = 0; index < tools.length; index += 1) {
    const entry = cached.entries[index];
    const tool = tools[index];
    if (entry.tool !== tool
      || entry.name !== tool?.name
      || entry.description !== tool?.description
      || entry.inputSchema !== tool?.inputSchema
      || entry.input_schema !== tool?.input_schema
      || entry.parameters !== tool?.parameters
      || entry.schema !== tool?.schema
      || entry.deferLoading !== tool?.deferLoading
      || entry.defer_loading !== tool?.defer_loading
      || entry.annotationsMixdogKind !== tool?.annotations?.mixdogKind
      || entry.annotationsAgentHidden !== tool?.annotations?.agentHidden
      || entry.native !== (index < nativePrefixCount)
      || entry.wireSignature !== toolSchemaSignature(toolMeteringList(tool, index < nativePrefixCount))) return false;
  }
  return true;
}

export function toolMeteringList(tool, native) {
  return native ? finalizeProviderRequestTools([tool], 1) : [tool];
}

export function toolSchemaEntry(tool, native = false) {
  return {
    tool,
    name: tool?.name,
    description: tool?.description,
    inputSchema: tool?.inputSchema,
    input_schema: tool?.input_schema,
    parameters: tool?.parameters,
    schema: tool?.schema,
    deferLoading: tool?.deferLoading,
    defer_loading: tool?.defer_loading,
    annotationsMixdogKind: tool?.annotations?.mixdogKind,
    annotationsAgentHidden: tool?.annotations?.agentHidden,
    native,
    wireSignature: toolSchemaSignature(toolMeteringList(tool, native)),
  };
}
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
  if (name === 'session_manage') return 'session';
  if (name.includes('channel') || name.includes('discord') || name.includes('webhook')) return 'channels';
  if (name.includes('provider') || name === 'load_tool' || name === 'tool_search' || name === 'cwd') return 'setup';
  if (kind === 'control') return 'control';
  return 'other';
}

export function estimateToolSchemaBreakdown(tools) {
  if (Array.isArray(tools)) {
    const cached = toolSchemaBreakdownMemo.get(tools);
    if (sameToolSchemaEntries(cached, tools)) return cached.value;
  }
  const out = {};
  const list = Array.isArray(tools) ? tools : [];
  const nativePrefixCount = providerNativeToolPrefixCount(list);
  for (let index = 0; index < list.length; index += 1) {
    const tool = list[index];
    const bucket = toolSchemaBucket(tool);
    const row = out[bucket] || { count: 0, tokens: 0 };
    row.count += 1;
    row.tokens += estimateToolSchemaTokens(toolMeteringList(tool, index < nativePrefixCount));
    out[bucket] = row;
  }
  if (Array.isArray(tools)) {
    toolSchemaBreakdownMemo.set(tools, {
      entries: tools.map((tool, index) => toolSchemaEntry(tool, index < nativePrefixCount)),
      value: out,
    });
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

export function measuredToolRank(name) {
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

export function activeToolForSurface(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  return JSON.parse(JSON.stringify(tool));
}

export function deferredProviderMode(provider) {
  const p = clean(provider).toLowerCase();
  if (p === 'gemini') return 'manifest';
  if (p === 'anthropic' || p === 'anthropic-oauth'
    || p === 'openai' || p === 'openai-oauth') {
    return 'native';
  }
  // xAI/Grok and every other OpenAI-compatible backend have no native
  // tool_search/tool_search_output contract. Give them one complete canonical
  // function array instead of a load-driven array whose bytes churn.
  return 'canonical';
}

export function nativeProviderFamily(provider) {
  const p = clean(provider).toLowerCase();
  if (p === 'openai' || p === 'openai-oauth') return 'openai';
  if (p === 'anthropic' || p === 'anthropic-oauth') return 'anthropic';
  return '';
}

export const ANTHROPIC_NATIVE_PROVIDERS = new Set(['anthropic', 'anthropic-oauth']);

// Pure projection of the tool definitions that the next provider request will
// serialize. Anthropic's native deferred surface sends the base active tools
// plus only definitions that have actually been discovered through the
// session/native tool-search history. Every other provider already receives
// its canonical/native surface in `tools`, so preserve that array verbatim.
