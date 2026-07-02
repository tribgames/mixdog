// Deferred-tool catalog: measured-usage ordering, kind/bucket classification,
// tool_search ranking + auto-selection, and the session tool-surface
// application/selection logic. Pure module (session objects passed in).
import { clean } from './session-text.mjs';
import { estimateToolSchemaTokens } from '../runtime/agent/orchestrator/session/context-utils.mjs';
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
  diagnostics: 2,
  recall: 2,
  search: 2,
  web_fetch: 2,
  provider_status: 2,
  channel_status: 2,
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
  'provider_status',
  'channel_status',
  'schedule_status',
  'fetch',
  'Skill',
]);
const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'find', 'glob'],
  search: ['search', 'web_fetch'],
  web: ['web_fetch', 'search'],
  memory: ['memory', 'recall'],
  channels: ['reply', 'fetch', 'react', 'edit_message', 'download_attachment', 'schedule_status', 'trigger_schedule', 'schedule_control', 'reload_config'],
  discord: ['reply', 'fetch', 'react', 'edit_message', 'download_attachment'],
  providers: ['provider_status'],
  provider: ['provider_status'],
  status: ['provider_status', 'channel_status', 'schedule_status'],
  schedule: ['schedule_status', 'trigger_schedule', 'schedule_control'],
  channel: ['channel_status'],
  explore: ['explore'],
  discovery: ['explore'],
  agent: ['agent'],
  graph: ['code_graph'],
  code: ['code_graph'],
  shell: ['shell', 'task'],
};
const TOOL_SEARCH_SAFE_AUTO_ALIASES = new Set([
  'shell',
  'web',
  'search',
  'agent',
  'provider',
  'providers',
  'channel',
  'schedule',
  'memory',
]);
const TOOL_SEARCH_AMBIGUOUS_AUTO_QUERIES = new Set([
  'status',
  'state',
  'info',
  'list',
  'show',
  'config',
]);
const TOOL_SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'me',
  'need',
  'of',
  'on',
  'please',
  'the',
  'to',
  'tool',
  'tools',
  'use',
  'using',
  'with',
]);
const TOOL_SEARCH_ROW_ALIASES = Object.freeze({
  agent: ['delegate', 'subagent', 'worker', 'parallel agent', 'background agent', 'reviewer', 'explorer'],
  channel_status: ['channel status', 'discord status', 'channel config'],
  cwd: ['cwd', 'working directory', 'current directory', 'project root', 'folder'],
  memory: ['save memory', 'store memory', 'delete memory', 'forget memory', 'memory status'],
  provider_status: ['provider status', 'auth status', 'model status', 'oauth status', 'provider config'],
  recall: ['recall', 'previous work', 'past work', 'prior context', 'history', 'resume context'],
  schedule_status: ['schedule status', 'cron status'],
  search: ['web search', 'internet search', 'current info', 'latest info', 'online search', 'docs search'],
  shell: ['run command', 'execute command', 'terminal', 'powershell', 'bash', 'run tests', 'test command', 'build command', 'npm', 'node', 'git'],
  task: ['background task', 'async task', 'wait task', 'cancel task', 'task status'],
  web_fetch: ['fetch url', 'fetch page', 'open url', 'web page', 'read url', 'docs page'],
});

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

function toolSearchTokens(value) {
  return (clean(value).toLowerCase().match(/[a-z0-9_.-]+/g) || [])
    .map((token) => token.replace(/[-.]+/g, '_'))
    .filter(Boolean);
}

function toolSearchMeaningfulTokens(value) {
  return toolSearchTokens(value).filter((token) => !TOOL_SEARCH_STOP_WORDS.has(token));
}

function toolSearchText(row) {
  const text = `${row.name} ${String(row.name || '').replace(/_/g, ' ')} ${row.kind} ${row.description} ${row.active ? 'active' : 'deferred'}`;
  return `${text} ${text.replace(/[-.]+/g, '_')}`.toLowerCase();
}

function toolSearchRowAliases(name) {
  return TOOL_SEARCH_ROW_ALIASES[clean(name)] || [];
}

function toolSearchRank(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return { score: 0, reasons: [] };
  const name = clean(row?.name).toLowerCase();
  const prettyName = name.replace(/_/g, ' ');
  const haystack = toolSearchText(row);
  const aliases = toolSearchRowAliases(name);
  const aliasText = aliases.join(' ').toLowerCase();
  const queryTokens = toolSearchMeaningfulTokens(raw);
  const nameTokens = new Set(toolSearchTokens(`${name} ${prettyName}`));
  const aliasTokens = new Set(toolSearchTokens(aliasText));
  let score = 0;
  const reasons = [];
  if (raw === name || raw === prettyName) {
    score += 120;
    reasons.push('exact-name');
  }
  if (aliases.some((alias) => raw === alias || raw === alias.replace(/[_-]+/g, ' '))) {
    score += 100;
    reasons.push('exact-alias');
  }
  // Stop-word-only queries (e.g. "tool", "to") have zero meaningful tokens.
  // Without an exact name/alias hit, they must not fall through to the raw
  // substring/haystack checks below — every row description likely contains
  // "tool" somewhere, producing a noisy pseudo-match list instead of "no
  // results". Exact name/alias matches stay intact even when the name is
  // itself a stop word.
  if (!queryTokens.length && !reasons.length) {
    return { score: 0, reasons: [] };
  }
  if (haystack.includes(raw)) {
    score += 34;
    reasons.push('phrase');
  }
  for (const alias of aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (normalizedAlias && raw.includes(normalizedAlias)) {
      score += 58;
      reasons.push('alias-phrase');
      break;
    }
  }
  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token) || name.includes(token)) {
      score += 24;
      matchedTokens += 1;
      continue;
    }
    if (aliasTokens.has(token) || aliasText.includes(token)) {
      score += 18;
      matchedTokens += 1;
      continue;
    }
    if (haystack.includes(token)) {
      score += 7;
      matchedTokens += 1;
    }
  }
  if (queryTokens.length && matchedTokens === queryTokens.length) {
    score += Math.min(18, queryTokens.length * 6);
    reasons.push('all-tokens');
  }
  if (clean(row?.kind).toLowerCase() === raw) score += 10;
  if (score > 0) score += Math.min(6, Math.floor(measuredToolUsage(name) / 150));
  return { score, reasons };
}

export function toolSearchMatches(row, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return true;
  return toolSearchRank(row, raw).score > 0;
}

function rankedToolSearchRows(rows, query) {
  const raw = clean(query).toLowerCase();
  if (!raw) return rows;
  return rows
    .map((row) => {
      const ranked = toolSearchRank(row, raw);
      return { ...row, score: ranked.score, reasons: ranked.reasons };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.active !== b.active) return a.active ? 1 : -1;
      if (b.usage !== a.usage) return b.usage - a.usage;
      return String(a.name).localeCompare(String(b.name));
    });
}

function isAsciiWordChar(ch) {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

// Matches `phrase` inside `text` at a word boundary. ASCII letters/digits on
// either side of the match block it (so "webhook" does not match "web" and
// "prune" does not match "run"); non-ASCII characters (e.g. Korean, where
// words are not space-separated) never count as word chars, so Korean
// substring phrases keep matching as before.
function phraseMatchesAsWords(text, phrase) {
  if (!phrase) return false;
  let idx = text.indexOf(phrase);
  while (idx !== -1) {
    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + phrase.length < text.length ? text[idx + phrase.length] : '';
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
    idx = text.indexOf(phrase, idx + 1);
  }
  return false;
}

function queryHasAnyPhrase(query, phrases) {
  const text = clean(query).toLowerCase().replace(/[_-]+/g, ' ');
  return phrases.some((phrase) => phraseMatchesAsWords(text, phrase));
}

const TOOL_SEARCH_AUTO_CATEGORY_BRANCHES = [
  {
    names: ['memory'],
    phrases: ['save memory', 'store memory', 'delete memory', 'forget memory', 'memory status', '기억 저장', '메모리 저장'],
  },
  {
    names: ['shell', 'task'],
    phrases: ['run', 'execute', 'test', 'tests', 'build', 'terminal', 'command', 'powershell', 'bash', 'shell', 'npm', 'node', 'git', '실행', '테스트', '빌드', '터미널', '쉘'],
  },
  {
    names: ['search', 'web_fetch'],
    phrases: ['web', 'internet', 'online', 'current info', 'latest', 'news', 'browse', 'docs', 'documentation', '웹', '인터넷', '최신', '뉴스', '문서'],
  },
  {
    names: ['recall'],
    phrases: ['recall', 'remember', 'memory previous', 'previous', 'history', 'past', 'prior', 'earlier', 'resume', '이전', '기억', '히스토리'],
  },
  {
    names: ['agent'],
    phrases: ['delegate', 'subagent', 'worker', 'parallel agent', 'background agent', 'reviewer', 'explorer', '에이전트', '워커', '병렬'],
  },
  {
    names: ['cwd'],
    phrases: ['working directory', 'project root', 'current directory', 'cwd'],
  },
];

function autoToolSelectionNames(query, rows) {
  const raw = clean(query).toLowerCase();
  if (!raw || TOOL_SEARCH_AMBIGUOUS_AUTO_QUERIES.has(raw)) return [];
  if (TOOL_SEARCH_SAFE_AUTO_ALIASES.has(raw) && DEFERRED_SELECT_ALIASES[raw]) {
    return DEFERRED_SELECT_ALIASES[raw];
  }
  const matchedBranches = TOOL_SEARCH_AUTO_CATEGORY_BRANCHES.filter((branch) =>
    queryHasAnyPhrase(raw, branch.phrases)
  );
  if (matchedBranches.length === 1) return matchedBranches[0].names;
  // Ambiguous (0 or 2+ category branches matched): never auto-load a
  // category's tools off a possibly-wrong guess. Fall through to the ranked
  // exact-name/alias path below; that path returns [] on its own when there
  // is no exact match, so an ambiguous query still safely resolves to [].
  const ranked = rankedToolSearchRows(rows, raw);
  const top = ranked[0];
  if (!top) return [];
  const reasons = new Set(top.reasons || []);
  if (reasons.has('exact-name') || reasons.has('exact-alias')) return [top.name];
  return [];
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

function isReadonlySelectable(tool) {
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
  return session;
}

export function selectDeferredTools(session, names, mode) {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const active = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const native = session?.deferredProviderMode === 'native' || session?.deferredNativeTools === true;
  const discovered = new Set(Array.isArray(session?.deferredDiscoveredTools) ? session.deferredDiscoveredTools : []);
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
    if (active.has(name) || discovered.has(name)) {
      already.push(name);
      continue;
    }
    if (native) {
      discovered.add(name);
    } else {
      session.tools.push(tool);
      active.add(name);
    }
    added.push(name);
  }
  if (native) {
    session.deferredDiscoveredTools = sortedNamesByMeasuredUsage(discovered);
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
  const initialActiveNames = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const initialRows = catalog.map((tool) => toolRow(tool, initialActiveNames)).filter((row) => row.name);
  const autoSelectedNames = (!forcedSelectedNames.length && query)
    ? autoToolSelectionNames(query, initialRows)
    : [];
  const selectedNames = forcedSelectedNames.length ? forcedSelectedNames : autoSelectedNames;
  const toolSelection = selectedNames.length ? selectDeferredTools(session, selectedNames, mode) : null;
  const selectionMode = forcedSelectedNames.length ? 'select' : (autoSelectedNames.length ? 'auto' : null);
  const nextActiveNames = new Set((session?.tools || []).map((tool) => clean(tool?.name)).filter(Boolean));
  const rows = [
    ...catalog.map((tool) => toolRow(tool, nextActiveNames)),
  ].filter((row) => row.name);
  const matches = query
    ? rankedToolSearchRows(rows, query)
    : rows;
  const selected = toolSelection
    ? {
        mode: selectionMode,
        tools: toolSelection,
      }
    : null;
  const nativeToolSearch = toolSelection?.native
    ? toolSearchNativePayload(catalog, toolSelection.added, session?.provider)
    : null;
  return JSON.stringify({
    selected,
    ...(nativeToolSearch ? { nativeToolSearch } : {}),
    totalMatches: matches.length,
    matches: matches.slice(0, limit),
    activeTools: sortedNamesByMeasuredUsage(nextActiveNames),
    discoveredTools: sortedNamesByMeasuredUsage(session?.deferredDiscoveredTools || []),
    note: 'query ranks matches and auto-loads high-confidence deferred tools; select exact tool names, or query select:a,b, to force load.',
  }, null, 2);
}
