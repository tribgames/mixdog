import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureStandaloneEnvironment } from './standalone/seeds.mjs';
import { createStandaloneBridge } from './standalone/bridge-tool.mjs';
import { createStandaloneChannelWorker } from './standalone/channel-worker.mjs';
import { createStandaloneHookBus } from './standalone/hook-bus.mjs';
import { writeLastSessionCwd } from './runtime/shared/user-cwd.mjs';
import {
  PROVIDER_STATUS_TOOL,
  forgetProviderAuth,
  loginOAuthProvider,
  providerSetup,
  renderProviderStatus,
  saveProviderApiKey,
  setLocalProvider,
} from './standalone/provider-admin.mjs';
import {
  channelSetup,
  deleteChannel,
  deleteSchedule,
  deleteWebhook,
  forgetDiscordToken,
  forgetWebhookAuthtoken,
  renderChannelStatus,
  saveChannel,
  saveDiscordToken,
  saveSchedule,
  saveWebhook,
  saveWebhookAuthtoken,
  setWebhookConfig,
} from './standalone/channel-admin.mjs';

const RUNTIME = './runtime/agent/orchestrator';
const SEARCH_RUNTIME = './runtime/search/index.mjs';
const MEMORY_TOOL_DEFS = './runtime/memory/tool-defs.mjs';
const MEMORY_RUNTIME = './runtime/memory/index.mjs';
const CHANNEL_TOOL_DEFS = './runtime/channels/tool-defs.mjs';
const CHANNEL_WORKER_ENTRY = './runtime/channels/index.mjs';
const CODE_GRAPH_TOOL_DEFS = './runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
const CODE_GRAPH_RUNTIME = './runtime/agent/orchestrator/tools/code-graph.mjs';
const STATUSLINE_SESSION_ROUTES = './vendor/statusline/src/gateway/session-routes.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const STANDALONE_ROOT = __dirname;

const DEFAULT_PROVIDER = 'anthropic-oauth';
const DEFAULT_MODEL = '';
const TOOL_MODES = new Set(['full', 'readonly', 'lead']);
const ALL_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_LABELS = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};
const EFFORT_OPTIONS_BY_PROVIDER = {
  openai: ['none', 'low', 'medium', 'high', 'xhigh'],
  'openai-oauth': ['none', 'low', 'medium', 'high', 'xhigh'],
  anthropic: ['low', 'medium', 'high', 'max'],
  'anthropic-oauth': ['low', 'medium', 'high', 'xhigh', 'max'],
  xai: ['none', 'low', 'medium', 'high'],
  'grok-oauth': ['none', 'low', 'medium', 'high'],
};
const EFFORT_BY_FAMILY = {
  opus: ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high'],
  haiku: [],
  'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-mini': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-nano': ['none', 'low', 'medium', 'high'],
  'gpt-codex': ['none', 'low', 'medium', 'high'],
  grok: ['none', 'low', 'medium', 'high'],
};
const EFFORT_FALLBACKS = {
  max: ['max', 'xhigh', 'high', 'medium', 'low'],
  xhigh: ['xhigh', 'high', 'medium', 'low'],
  high: ['high', 'medium', 'low'],
  medium: ['medium', 'low'],
  low: ['low'],
  none: ['none'],
};

const TOOL_SEARCH_TOOL = {
  name: 'tool_search',
  title: 'Tool Search',
  annotations: {
    title: 'Tool Search',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: 'Search the current standalone tool surface and select tools/skills for the task. Use before deferred or unfamiliar tools.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search text, e.g. edit, bridge, memory, skill, mcp.' },
      select: { type: ['string', 'array'], description: 'Comma-separated tool names or an array of tool names to select.' },
      limit: { type: 'number', description: 'Maximum matches to return.' },
    },
    additionalProperties: false,
  },
};

const CHANNEL_STATUS_TOOL = {
  name: 'channel_status',
  title: 'Channel Status',
  annotations: {
    title: 'Channel Status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    bridgeHidden: true,
  },
  description: 'List standalone Discord/channel/schedule/webhook configuration status. This never returns secrets.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const CWD_TOOL = {
  name: 'cwd',
  title: 'Current Working Directory',
  annotations: {
    title: 'Current Working Directory',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    bridgeHidden: true,
  },
  description: 'Show or set the standalone session working directory. action=get|set; path is required for set.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'Default get, or set when path is provided.' },
      path: { type: 'string', description: 'Directory path for action=set. Relative paths resolve from the current cwd.' },
    },
    additionalProperties: false,
  },
};

const MEASURED_TOOL_USAGE = Object.freeze({
  read: 710,
  grep: 349,
  bridge: 330,
  edit: 322,
  apply_patch: 300,
  code_graph: 83,
  bash: 81,
  glob: 55,
  write: 38,
  list: 37,
  explore: 10,
  cwd: 2,
  diagnostics: 2,
  recall: 2,
});
const MEASURED_TOOL_ORDER = Object.freeze(Object.keys(MEASURED_TOOL_USAGE));
const DEFERRED_ALWAYS_ACTIVE_TOOLS = new Set([
  'tool_search',
]);
const DEFERRED_DEFAULT_FULL_LIMIT = 6;
const DEFERRED_DEFAULT_READONLY_TOOLS = Object.freeze([
  'read',
  'grep',
  'code_graph',
  'list',
  'tool_search',
]);
const DEFERRED_DEFAULT_LEAD_TOOLS = Object.freeze([
  'read',
  'grep',
  'bridge',
  'apply_patch',
  'recall',
  'search',
  'web_fetch',
  'code_graph',
  'cwd',
  'list',
  'tool_search',
]);
const READONLY_TOOL_NAMES = new Set([
  'read',
  'list',
  'grep',
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
]);
const DEFERRED_SELECT_ALIASES = {
  filesystem: ['read', 'list', 'grep', 'glob'],
  search: ['search', 'web_fetch'],
  web: ['web_fetch', 'search'],
  memory: ['memory', 'recall'],
  channels: ['reply', 'fetch', 'react', 'edit_message', 'download_attachment', 'schedule_status', 'trigger_schedule', 'schedule_control', 'reload_config'],
  discord: ['reply', 'fetch', 'react', 'edit_message', 'download_attachment'],
  schedule: ['schedule_status', 'trigger_schedule', 'schedule_control'],
  bridge: ['bridge'],
  graph: ['code_graph'],
  code: ['code_graph'],
  write: ['edit', 'write', 'apply_patch'],
  edit: ['edit'],
  shell: ['bash', 'job_wait'],
  bash: ['bash', 'job_wait'],
};
const COMPACT_TOOL_DESCRIPTIONS = Object.freeze({
  read: 'Read files. Use path; offset/limit or line/context for windows; symbol for definitions.',
  grep: 'Ripgrep content search. Use pattern plus optional path/glob; output_mode controls result shape.',
  edit: 'Small exact replacements only. Prefer apply_patch for structural or multi-file edits.',
  apply_patch: 'First-class file patch editor. Use v4a; read target first; base_path should be the repo root.',
  code_graph: 'Code structure lookup: symbols, callers/callees, references, imports, dependents, impact.',
  bridge: 'Spawn/send/list/read/close worker agents. Use sync for immediate result or async for jobs.',
  bash: 'Run shell commands for git/build/test. Set shell explicitly on Windows.',
  list: 'List/find directory entries. Use mode=list/tree/find; fuzzy ranks partial names.',
  recall: 'Retrieve stored memory or prior work. Use query and optional filters.',
  search: 'Web search for current/external info. Use web_fetch for page bodies.',
  web_fetch: 'Fetch full body for a URL.',
  tool_search: 'Search/select deferred tools for the next model iteration.',
  cwd: 'Show or set the standalone session cwd.',
});
const COMPACT_PROPERTY_DESCRIPTIONS = Object.freeze({
  read: {
    path: 'File path.',
    offset: 'Start line, 1-based.',
    limit: 'Max lines.',
    line: 'Line number.',
    context: 'Lines around line.',
    symbol: 'Definition name.',
    mode: 'Whole-file glance.',
    full: 'Return whole file when safe.',
  },
  grep: {
    pattern: 'Regex string or array.',
    path: 'File/dir scope.',
    glob: 'Glob filter.',
    output_mode: 'content, files_with_matches, or count.',
    head_limit: 'Max result lines.',
    offset: 'Skip result lines.',
  },
  edit: {
    operation: 'replace, notebook, or rename.',
    path: 'Target path.',
    old_string: 'Exact current text.',
    new_string: 'Replacement text.',
    replace_all: 'Replace every match.',
    edits: 'Batch replacements.',
  },
  apply_patch: {
    patch: 'Patch text. Prefer v4a: *** Begin Patch / *** Update File / context lines starting space, - deletes, + adds / *** End Patch. Use unique context copied from current file.',
    format: 'v4a or unified. Prefer v4a.',
    base_path: 'Repo root.',
    dry_run: 'Validate only.',
    reject_partial: 'All-or-nothing by default.',
    fuzzy: 'Allow minor context drift.',
  },
  code_graph: {
    mode: 'overview/imports/dependents/related/impact/symbols/find_symbol/search/references/callers/callees/prewarm.',
    file: 'Target file or scope.',
    symbol: 'Identifier or keyword.',
    symbols: 'Batch names.',
    body: 'Include declaration body for find_symbol.',
    limit: 'Max results.',
    depth: 'Caller/callee depth.',
    page: 'Paged graph results.',
    cwd: 'Project root.',
  },
  bridge: {
    type: 'spawn/send/list/status/read/cleanup/cancel/close.',
    mode: 'sync or async.',
    wait: 'true waits; false returns a job.',
    jobId: 'Async job id.',
    role: 'Worker role.',
    tag: 'Stable worker handle.',
    sessionId: 'Raw session id.',
    prompt: 'Worker task brief.',
    message: 'Follow-up message.',
    file: 'Prompt file.',
    cwd: 'Worker cwd.',
  },
  list: {
    path: 'Directory path.',
    mode: 'list/tree/find.',
    depth: 'Tree depth.',
    hidden: 'Include hidden.',
    sort: 'name/mtime/size.',
    type: 'file/dir/any.',
    head_limit: 'Max entries.',
    offset: 'Skip entries.',
    fuzzy: 'Partial-name ranking.',
  },
  recall: {
    query: 'Search text.',
    period: 'last/24h/3d/7d/30d/all/date/range.',
    sort: 'date or importance.',
    category: 'Memory category filter.',
    projectScope: 'Project pool.',
    cwd: 'Workspace path.',
  },
  search: {
    query: 'Search text or array.',
    limit: 'Max results.',
  },
  web_fetch: {
    url: 'URL to fetch.',
  },
  tool_search: {
    query: 'Search text.',
    select: 'Tool names or aliases.',
    limit: 'Max matches.',
  },
  cwd: {
    action: 'get or set.',
    path: 'Directory for set.',
  },
});

function normalizeToolMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return TOOL_MODES.has(value) ? value : 'full';
}

function normalizeEffortInput(value) {
  const v = clean(value).toLowerCase();
  if (!v || v === 'auto') return null;
  if (!ALL_EFFORT_LEVELS.has(v)) {
    throw new Error(`effort must be one of auto, ${[...ALL_EFFORT_LEVELS].join(', ')}`);
  }
  return v;
}

function effortOptionsFor(provider, model) {
  const providerAllowed = EFFORT_OPTIONS_BY_PROVIDER[provider] || null;
  const filterProvider = (values) => {
    const unique = [...new Set((values || []).map(clean).filter(Boolean))];
    return providerAllowed ? unique.filter((v) => providerAllowed.includes(v)) : unique;
  };
  const declared = Array.isArray(model?.reasoningLevels)
    ? model.reasoningLevels.map(clean).filter(Boolean)
    : [];
  if (declared.length > 0) return filterProvider(declared);
  const family = clean(model?.family).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EFFORT_BY_FAMILY, family)) {
    return filterProvider(EFFORT_BY_FAMILY[family]);
  }
  return providerAllowed || [];
}

function coerceEffortFor(provider, model, effort) {
  if (!effort) return null;
  const allowed = effortOptionsFor(provider, model);
  if (!allowed || allowed.length === 0) return null;
  if (allowed.includes(effort)) return effort;
  for (const candidate of EFFORT_FALLBACKS[effort] || []) {
    if (allowed.includes(candidate)) return candidate;
  }
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function effortItemsFor(provider, model, activeEffort) {
  const allowed = effortOptionsFor(provider, model);
  const items = [{ value: 'auto', label: 'auto', description: 'provider/model default' }];
  for (const value of allowed || []) {
    items.push({
      value,
      label: EFFORT_LABELS[value] || value,
      description: value === activeEffort ? 'current' : '',
    });
  }
  return items;
}

function toolSpecForMode(mode) {
  return mode === 'readonly' ? ['tools:readonly'] : 'full';
}

function clean(value) {
  return String(value ?? '').trim();
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function listDirsSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function countSkillFiles(root) {
  const skillsDir = join(root, 'skills');
  if (!existsSync(skillsDir)) return 0;
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(SKILL|skill)\.md$/i.test(entry.name) || entry.name.toLowerCase().endsWith('.md')) count += 1;
    }
  };
  try { walk(skillsDir); } catch { return count; }
  return count;
}

function mcpScriptForPlugin(root) {
  const candidates = [
    'scripts/run-mcp.mjs',
    'mcp/server.mjs',
    'server.mjs',
  ];
  return candidates.find((rel) => existsSync(join(root, rel))) || null;
}

function pluginManifest(root) {
  return readJsonSafe(join(root, '.codex-plugin', 'plugin.json'))
    || readJsonSafe(join(root, '.claude-plugin', 'plugin.json'))
    || readJsonSafe(join(root, 'plugin.json'))
    || {};
}

function pluginMcpServerName(plugin = {}) {
  const base = clean(plugin.name || plugin.title || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base ? `plugin-${base}` : 'plugin-mcp';
}

function findPreset(config, key) {
  const wanted = clean(key).toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return presets.find((p) => {
    const id = clean(p?.id).toLowerCase();
    const name = clean(p?.name).toLowerCase();
    return id === wanted || name === wanted;
  }) || null;
}

function resolveRoute(config, { provider, model, effort } = {}) {
  const explicitProvider = clean(provider);
  const explicitModel = clean(model);
  const hasExplicitEffort = effort !== undefined;
  const explicitEffort = hasExplicitEffort ? normalizeEffortInput(effort) : undefined;

  if (explicitModel && !explicitProvider) {
    const preset = findPreset(config, explicitModel);
    if (preset) {
      return {
        provider: clean(preset.provider) || DEFAULT_PROVIDER,
        model: clean(preset.model) || DEFAULT_MODEL,
        preset,
        ...(hasExplicitEffort ? { effort: explicitEffort } : {}),
      };
    }
  }

  if (!explicitProvider && !explicitModel) {
    const defaultKey = config?.default;
    const preset = findPreset(config, defaultKey);
    if (preset) {
      return {
        provider: clean(preset.provider) || DEFAULT_PROVIDER,
        model: clean(preset.model) || DEFAULT_MODEL,
        preset,
        ...(hasExplicitEffort ? { effort: explicitEffort } : {}),
      };
    }
  }

  return {
    provider: explicitProvider || DEFAULT_PROVIDER,
    model: explicitModel || DEFAULT_MODEL,
    preset: null,
    ...(hasExplicitEffort ? { effort: explicitEffort } : {}),
  };
}

function ensureProviderEnabled(config, provider) {
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  return providers;
}

function routeForStatusline(route) {
  const out = {
    mode: 'fixed',
    defaultProvider: route.provider,
    defaultModel: route.model,
  };
  const preset = route.preset || {};
  if (preset.id) out.presetId = preset.id;
  if (preset.name) out.presetName = preset.name;
  if (preset.modelDisplay) out.modelDisplay = preset.modelDisplay;
  if (preset.fast === true || preset.fast === false) out.fast = preset.fast;
  if (route.effectiveEffort) {
    out.effort = route.effectiveEffort;
    out.displayEffort = route.effectiveEffort;
  } else if (hasOwn(route, 'effort')) {
    delete out.effort;
    delete out.displayEffort;
  }
  return out;
}

const ONBOARDING_VERSION = 1;
const WORKFLOW_ROUTE_SLOTS = ['lead', 'bridge', 'explorer', 'search', 'memory'];

function workflowPresetId(slot) {
  return `workflow-${slot}`;
}

function workflowPresetName(slot) {
  return `WORKFLOW ${String(slot || '').toUpperCase()}`;
}

function normalizeWorkflowRoute(routeLike, fallback = {}) {
  const provider = clean(routeLike?.provider) || clean(fallback.provider);
  const model = clean(routeLike?.model) || clean(fallback.model);
  if (!provider || !model) return null;
  const effort = normalizeEffortInput(routeLike?.effort ?? fallback.effort);
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
  };
}

function upsertWorkflowPreset(presets, slot, routeLike) {
  const route = normalizeWorkflowRoute(routeLike);
  if (!route) return presets;
  const id = workflowPresetId(slot);
  const preset = {
    id,
    name: workflowPresetName(slot),
    type: 'bridge',
    provider: route.provider,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    tools: 'full',
  };
  const next = (Array.isArray(presets) ? presets : []).filter((p) => clean(p?.id) !== id && clean(p?.name) !== preset.name);
  next.push(preset);
  return next;
}

function summarizeWorkflowRoutes(config) {
  const routes = config?.workflowRoutes && typeof config.workflowRoutes === 'object' ? config.workflowRoutes : {};
  const out = {};
  for (const slot of WORKFLOW_ROUTE_SLOTS) {
    const route = routes[slot];
    if (route?.provider && route?.model) out[slot] = normalizeWorkflowRoute(route);
  }
  return out;
}

function toolResponseText(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content
      .map((part) => (part?.type === 'text' ? part.text || '' : JSON.stringify(part)))
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

function parseToolSelection(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return String(value || '')
    .split(/[,\s]+/)
    .map(clean)
    .filter(Boolean);
}

function toolKind(tool) {
  const name = clean(tool?.name);
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('skill_') || name === 'skills_list') return 'skill';
  if (tool?.annotations?.bridgeHidden) return 'control';
  if (['edit', 'write', 'apply_patch', 'bash'].includes(name)) return 'write';
  return 'tool';
}

function measuredToolUsage(name) {
  return MEASURED_TOOL_USAGE[clean(name)] || 0;
}

function measuredToolRank(name) {
  const index = MEASURED_TOOL_ORDER.indexOf(clean(name));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortedCatalogByMeasuredUsage(catalog) {
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

function compactSchemaDescriptions(toolName, node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => compactSchemaDescriptions(toolName, item));
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const nextProp = compactSchemaDescriptions(toolName, propSchema);
        const desc = COMPACT_PROPERTY_DESCRIPTIONS[toolName]?.[propName];
        if (desc) nextProp.description = desc;
        out.properties[propName] = nextProp;
      }
      continue;
    }
    out[key] = compactSchemaDescriptions(toolName, value);
  }
  return out;
}

function compactToolForSurface(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const name = clean(tool.name);
  const next = {
    ...tool,
    description: COMPACT_TOOL_DESCRIPTIONS[name] || clean(tool.description),
  };
  if (tool.inputSchema && typeof tool.inputSchema === 'object') {
    next.inputSchema = compactSchemaDescriptions(name, tool.inputSchema);
  }
  return next;
}

function sortedNamesByMeasuredUsage(names) {
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

function defaultDeferredToolNames(catalog, mode) {
  if (mode === 'lead') {
    const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
    return new Set(DEFERRED_DEFAULT_LEAD_TOOLS.filter((name) => available.has(name)));
  }
  if (mode === 'readonly') {
    const available = new Set((catalog || []).map((tool) => clean(tool?.name)).filter(Boolean));
    return new Set(DEFERRED_DEFAULT_READONLY_TOOLS.filter((name) => available.has(name)));
  }
  const names = new Set(DEFERRED_ALWAYS_ACTIVE_TOOLS);
  const limit = DEFERRED_DEFAULT_FULL_LIMIT;
  for (const tool of sortedCatalogByMeasuredUsage(catalog)) {
    const name = clean(tool?.name);
    if (!name || names.has(name)) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    names.add(name);
    if (names.size >= DEFERRED_ALWAYS_ACTIVE_TOOLS.size + limit) break;
  }
  return names;
}

function toolRow(tool, activeNames = new Set()) {
  const name = clean(tool?.name);
  return {
    name,
    kind: toolKind(tool),
    usage: measuredToolUsage(name),
    active: activeNames.has(name),
    description: clean(tool?.description),
  };
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

function isReadonlySelectable(tool) {
  const name = clean(tool?.name);
  if (READONLY_TOOL_NAMES.has(name)) return true;
  const annotations = tool?.annotations || {};
  if (annotations.destructiveHint === true) return false;
  if (annotations.readOnlyHint === true) return true;
  return false;
}

function applyDeferredToolSurface(session, mode, extraTools = []) {
  if (!session || !Array.isArray(session.tools)) return session;
  const byName = new Map();
  for (const tool of [...session.tools, ...(extraTools || [])]) {
    const name = clean(tool?.name);
    if (!name || byName.has(name)) continue;
    byName.set(name, compactToolForSurface(tool));
  }
  const catalog = sortedCatalogByMeasuredUsage([...byName.values()]);
  const defaultNames = defaultDeferredToolNames(catalog, mode);
  session.deferredToolCatalog = catalog;
  session.deferredToolUsage = MEASURED_TOOL_USAGE;
  session.deferredSelectedTools = sortedNamesByMeasuredUsage(defaultNames);
  session.tools.length = 0;
  for (const tool of catalog) {
    if (!defaultNames.has(clean(tool?.name))) continue;
    if (mode === 'readonly' && !isReadonlySelectable(tool)) continue;
    session.tools.push(tool);
  }
  return session;
}

function selectDeferredTools(session, names, mode) {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const active = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
  const byName = new Map(catalog.map((tool) => [tool?.name, tool]).filter(([name]) => name));
  const added = [];
  const already = [];
  const blocked = [];
  const missing = [];
  for (const name of expandSelectionNames(names)) {
    const tool = byName.get(name);
    if (!tool) {
      missing.push(name);
      continue;
    }
    if (mode === 'readonly' && !isReadonlySelectable(tool)) {
      blocked.push({ name, reason: 'readonly mode' });
      continue;
    }
    if (active.has(name)) {
      already.push(name);
      continue;
    }
    session.tools.push(tool);
    active.add(name);
    added.push(name);
  }
  session.deferredSelectedTools = sortedNamesByMeasuredUsage(active);
  return { added, already, blocked, missing };
}

function renderToolSearch(args = {}, session, mode = 'full') {
  const catalog = Array.isArray(session?.deferredToolCatalog)
    ? session.deferredToolCatalog
    : (Array.isArray(session?.tools) ? session.tools : []);
  const activeNames = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
  const query = clean(args.query).toLowerCase();
  const selectedNames = parseToolSelection(args.select);
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const selection = selectedNames.length ? selectDeferredTools(session, selectedNames, mode) : null;
  const nextActiveNames = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
  const rows = catalog.map((tool) => toolRow(tool, nextActiveNames)).filter((row) => row.name);
  const matches = query
    ? rows.filter((row) => `${row.name} ${row.kind} ${row.description} ${row.active ? 'active' : 'deferred'}`.toLowerCase().includes(query))
    : rows;
  return JSON.stringify({
    selected: selection,
    matches: matches.slice(0, limit),
    activeTools: sortedNamesByMeasuredUsage(nextActiveNames),
    measuredUsage: MEASURED_TOOL_USAGE,
    note: 'standalone: tool_search adds deferred tools to the current session schema for the next model iteration.',
  }, null, 2);
}

function resolveCwdPath(currentCwd, value) {
  const raw = clean(value);
  if (!raw) throw new Error('cwd: path is required for action=set');
  const next = resolve(currentCwd || process.cwd(), raw);
  const stat = statSync(next);
  if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${next}`);
  return next;
}

export async function createMixdogSessionRuntime({
  provider,
  model,
  cwd = process.cwd(),
  toolMode = 'full',
} = {}) {
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';
  ensureStandaloneEnvironment({
    rootDir: STANDALONE_ROOT,
    dataDir: process.env.MIXDOG_DATA_DIR || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.mixdog', 'data'),
  });

  const cfgMod = await import(`${RUNTIME}/config.mjs`);
  const reg = await import(`${RUNTIME}/providers/registry.mjs`);
  const mcpClient = await import(`${RUNTIME}/mcp/client.mjs`);
  const mgr = await import(`${RUNTIME}/session/manager.mjs`);
  const contextMod = await import(`${RUNTIME}/context/collect.mjs`);
  const internalTools = await import(`${RUNTIME}/internal-tools.mjs`);
  const statusRoutes = await import(STATUSLINE_SESSION_ROUTES).catch(() => null);
  const searchMod = await import(SEARCH_RUNTIME).catch(() => null);
  const memoryToolDefs = await import(MEMORY_TOOL_DEFS).catch(() => null);
  const channelToolDefs = await import(CHANNEL_TOOL_DEFS).catch(() => null);
  const codeGraphToolDefs = await import(CODE_GRAPH_TOOL_DEFS).catch(() => null);
  let memoryModPromise = null;
  let memoryInitPromise = null;
  let codeGraphModPromise = null;

  async function getMemoryModule() {
    memoryModPromise ??= import(MEMORY_RUNTIME);
    const mod = await memoryModPromise;
    if (typeof mod?.init === 'function') {
      memoryInitPromise ??= mod.init();
      await memoryInitPromise;
    }
    return mod;
  }

  async function getCodeGraphModule() {
    codeGraphModPromise ??= import(CODE_GRAPH_RUNTIME);
    return await codeGraphModPromise;
  }

  let config = cfgMod.loadConfig();
  let route = resolveRoute(config, { provider, model });
  let mode = normalizeToolMode(toolMode);
  let session = null;
  let currentCwd = cwd;
  const modelMetaByRoute = new Map();
  let mcpFailures = [];
  const hooks = createStandaloneHookBus({ dataDir: cfgMod.getPluginData() });
  hooks.emit('runtime:start', { cwd: currentCwd, provider: route.provider, model: route.model, toolMode: mode });

  function mcpTransportLabel(cfg = {}) {
    if (cfg.pluginCache) return `pluginCache:${cfg.pluginCache}`;
    if (cfg.autoDetect) return `autoDetect:${cfg.autoDetect}`;
    if (cfg.transport === 'http' || cfg.url) return 'http';
    if (cfg.command) return 'stdio';
    return 'unknown';
  }

  function mcpStatus() {
    const configured = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    const connected = new Map((mcpClient.getMcpServerStatus?.() || []).map((row) => [row.name, row]));
    const failures = new Map((mcpFailures || []).map((row) => [row.name, row]));
    const servers = [];
    for (const [name, cfg] of Object.entries(configured)) {
      const live = connected.get(name);
      const fail = failures.get(name);
      servers.push({
        name,
        configured: true,
        connected: Boolean(live),
        status: live ? 'connected' : fail ? 'failed' : 'disconnected',
        transport: mcpTransportLabel(cfg),
        toolCount: live?.toolCount || 0,
        tools: live?.tools || [],
        error: fail?.msg || null,
      });
      connected.delete(name);
    }
    for (const live of connected.values()) {
      servers.push({ ...live, configured: false, status: 'connected' });
    }
    servers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return {
      servers,
      configuredCount: Object.keys(configured).length,
      connectedCount: servers.filter((row) => row.connected).length,
      failedCount: servers.filter((row) => row.status === 'failed').length,
    };
  }

  function skillsStatus() {
    const skills = typeof contextMod.collectSkillsCached === 'function'
      ? contextMod.collectSkillsCached(currentCwd)
      : [];
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const cwdNorm = norm(currentCwd);
    const userSkillRoot = norm(join(homedir(), '.claude', 'skills'));
    const pluginSkillRoot = norm(join(homedir(), '.claude', 'plugins', 'marketplaces'));
    const sourceForSkill = (filePath) => {
      const path = norm(filePath);
      if (cwdNorm && path.startsWith(`${cwdNorm}/.claude/skills/`)) return 'project';
      if (userSkillRoot && path.startsWith(`${userSkillRoot}/`)) return 'user';
      if (pluginSkillRoot && path.startsWith(`${pluginSkillRoot}/`)) return 'plugin';
      return 'skill';
    };
    return {
      cwd: currentCwd,
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || '',
        filePath: skill.filePath || null,
        source: sourceForSkill(skill.filePath),
      })),
    };
  }

  function skillContent(name) {
    const content = typeof contextMod.loadSkillContent === 'function'
      ? contextMod.loadSkillContent(name, currentCwd)
      : null;
    if (!content) throw new Error(`skill not found: ${name}`);
    return { name, content };
  }

  function pluginsStatus() {
    const plugins = [];
    const seen = new Set();
    const configuredMcp = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    const addPlugin = ({ root, source, marketplace, version, fallbackName }) => {
      if (!root || !existsSync(root)) return;
      const manifest = pluginManifest(root);
      const name = clean(manifest.name) || clean(manifest.id) || clean(fallbackName) || root.split(/[\\/]/).pop() || root;
      const key = `${source}:${marketplace || ''}:${name}:${version || manifest.version || ''}:${root}`;
      if (seen.has(key)) return;
      seen.add(key);
      const plugin = {
        name,
        title: clean(manifest.title) || clean(manifest.displayName) || name,
        version: clean(version) || clean(manifest.version) || null,
        description: clean(manifest.description),
        marketplace: marketplace || null,
        source,
        root,
        skillCount: countSkillFiles(root),
        mcpScript: mcpScriptForPlugin(root),
      };
      plugin.mcpServerName = pluginMcpServerName(plugin);
      plugin.mcpEnabled = Object.prototype.hasOwnProperty.call(configuredMcp, plugin.mcpServerName);
      plugins.push(plugin);
    };

    const marketplaceBase = join(homedir(), '.claude', 'plugins', 'marketplaces');
    for (const marketplace of listDirsSafe(marketplaceBase)) {
      const external = join(marketplaceBase, marketplace, 'external_plugins');
      for (const pluginName of listDirsSafe(external)) {
        addPlugin({ root: join(external, pluginName), source: 'marketplace', marketplace, fallbackName: pluginName });
      }
    }

    const cacheBase = join(homedir(), '.claude', 'plugins', 'cache');
    for (const marketplace of listDirsSafe(cacheBase)) {
      const marketplaceDir = join(cacheBase, marketplace);
      for (const pluginName of listDirsSafe(marketplaceDir)) {
        const pluginDir = join(marketplaceDir, pluginName);
        for (const version of listDirsSafe(pluginDir)) {
          addPlugin({ root: join(pluginDir, version), source: 'cache', marketplace, version, fallbackName: pluginName });
        }
      }
    }

    const codexCacheBase = join(homedir(), '.codex', 'plugins', 'cache');
    for (const marketplace of listDirsSafe(codexCacheBase)) {
      const marketplaceDir = join(codexCacheBase, marketplace);
      for (const pluginName of listDirsSafe(marketplaceDir)) {
        const pluginDir = join(marketplaceDir, pluginName);
        for (const version of listDirsSafe(pluginDir)) {
          addPlugin({ root: join(pluginDir, version), source: 'codex-cache', marketplace, version, fallbackName: pluginName });
        }
      }
    }

    plugins.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      if ((a.marketplace || '') !== (b.marketplace || '')) return String(a.marketplace || '').localeCompare(String(b.marketplace || ''));
      return a.name.localeCompare(b.name);
    });
    return {
      count: plugins.length,
      plugins,
      roots: {
        marketplaces: marketplaceBase,
        cache: cacheBase,
        codexCache: codexCacheBase,
      },
    };
  }

  async function connectConfiguredMcp({ reset = false } = {}) {
    if (reset) await mcpClient.disconnectAll?.();
    mcpFailures = [];
    const servers = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    if (Object.keys(servers).length === 0) return mcpStatus();
    try {
      await mcpClient.connectMcpServers(servers);
    } catch (error) {
      mcpFailures = Array.isArray(error?.failures)
        ? error.failures
        : [{ name: 'mcp', msg: error?.message || String(error) }];
    }
    return mcpStatus();
  }

  const bridge = createStandaloneBridge({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
  const channels = createStandaloneChannelWorker({
    entry: join(STANDALONE_ROOT, CHANNEL_WORKER_ENTRY.replace(/^\.\//, '')),
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    CWD_TOOL,
    ...(searchMod?.TOOL_DEFS || []).filter((tool) => tool?.name === 'search' || tool?.name === 'web_fetch'),
    ...(memoryToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'recall' || tool?.name === 'memory'),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => channels.isChannelTool(tool?.name)),
    ...(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS || []).filter((tool) => tool?.name === 'code_graph'),
    ...bridge.tools,
    PROVIDER_STATUS_TOOL,
    CHANNEL_STATUS_TOOL,
  ];
  internalTools.setInternalToolsProvider({
    tools: standaloneTools,
    executor: async (name, args, callerCtx = {}) => {
      const callerCwd = callerCtx?.callerCwd || currentCwd;
      if ((name === 'search' || name === 'web_fetch') && searchMod?.handleToolCall) {
        return await searchMod.handleToolCall(name, args || {});
      }
      if (name === 'recall' || name === 'memory' || name === 'search_memories') {
        const memoryMod = await getMemoryModule();
        if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
        return await memoryMod.handleToolCall(name, args || {});
      }
      if (name === 'code_graph') {
        const codeGraphMod = await getCodeGraphModule();
        if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
        return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
      }
      if (name === 'tool_search') return renderToolSearch(args, session, mode);
      if (name === 'cwd') {
        const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
        if (action === 'set') {
          currentCwd = resolveCwdPath(currentCwd, args?.path);
          process.env.MIXDOG_SESSION_CWD = currentCwd;
          writeLastSessionCwd(currentCwd);
          if (session) session.cwd = currentCwd;
        } else if (action !== 'get') {
          throw new Error(`cwd: unknown action "${action}"`);
        }
        return JSON.stringify({ cwd: currentCwd, sessionId: session?.id || null }, null, 2);
      }
      if (name === 'bridge') return await bridge.execute(args, { callerCwd });
      if (name === 'provider_status') return renderProviderStatus(cfgMod.loadConfig());
      if (name === 'channel_status') return renderChannelStatus();
      if (channels.isChannelTool(name)) return await channels.execute(name, args || {});
      throw new Error(`unknown standalone internal tool: ${name}`);
    },
  });
  internalTools.markBootReady?.();
  await connectConfiguredMcp();
  channels.start().catch(() => {});

  function reloadChannelsSoon() {
    channels.execute('reload_config', {}).catch(() => {});
  }

  function modelMetaKey(providerId, modelId) {
    return `${clean(providerId)}\n${clean(modelId)}`;
  }

  async function lookupModelMeta(providerId, modelId) {
    const key = modelMetaKey(providerId, modelId);
    if (modelMetaByRoute.has(key)) return modelMetaByRoute.get(key);
    const providerImpl = reg.getProvider(providerId);
    if (!providerImpl || typeof providerImpl.listModels !== 'function') {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      return fallback;
    }
    try {
      const models = await providerImpl.listModels();
      const found = Array.isArray(models) ? models.find((m) => m?.id === modelId) : null;
      const meta = found || { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, meta);
      return meta;
    } catch {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      return fallback;
    }
  }

  async function refreshRouteEffort() {
    await reg.initProviders(ensureProviderEnabled(config, route.provider));
    const modelMeta = await lookupModelMeta(route.provider, route.model);
    const requested = hasOwn(route, 'effort') ? route.effort : (route.preset?.effort || null);
    const effectiveEffort = coerceEffortFor(route.provider, modelMeta, requested);
    route = { ...route, effectiveEffort, effortOptions: effortItemsFor(route.provider, modelMeta, effectiveEffort) };
    return route;
  }

  async function createCurrentSession() {
    await refreshRouteEffort();
    const providerImpl = reg.getProvider(route.provider);
    if (!providerImpl) {
      throw new Error(`Provider "${route.provider}" is not configured.`);
    }
    const sessionOpts = {
      provider: route.provider,
      model: route.model,
      preset: route.preset || undefined,
      tools: toolSpecForMode(mode),
      owner: 'cli',
      lane: 'cli',
      sourceType: 'cli',
      sourceName: 'main',
      disallowedTools: ['diagnostics', 'open_config'],
      cwd: currentCwd,
    };
    if (hasOwn(route, 'effort') || route.effectiveEffort) {
      sessionOpts.effort = route.effectiveEffort || null;
    }
    session = mgr.createSession(sessionOpts);
    Object.defineProperty(session, 'beforeToolHook', {
      value: (input) => hooks.beforeTool(input),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    applyDeferredToolSurface(session, mode, standaloneTools);
    statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
    hooks.emit('session:create', { sessionId: session.id, provider: route.provider, model: route.model, toolMode: mode, cwd: currentCwd });
    return session;
  }

  await createCurrentSession();

  return {
    get id() {
      return session?.id || null;
    },
    get provider() {
      return route.provider;
    },
    get model() {
      return route.model;
    },
    get effort() {
      return route.effectiveEffort || null;
    },
    get effortOptions() {
      return route.effortOptions || [{ value: 'auto', label: 'auto', description: 'provider/model default' }];
    },
    get toolMode() {
      return mode;
    },
    get bridgeMode() {
      return bridge.getDefaultMode();
    },
    get cwd() {
      return currentCwd;
    },
    get session() {
      return session;
    },
    listProviders() {
      return renderProviderStatus(cfgMod.loadConfig());
    },
    async getProviderSetup() {
      return await providerSetup(cfgMod.loadConfig());
    },
    getOnboardingStatus() {
      const nextConfig = cfgMod.loadConfig();
      return {
        completed: nextConfig?.onboarding?.completed === true,
        version: nextConfig?.onboarding?.version || 0,
        default: nextConfig?.default || null,
        workflowRoutes: summarizeWorkflowRoutes(nextConfig),
      };
    },
    async completeOnboarding(payload = {}) {
      const defaultRoute = normalizeWorkflowRoute(payload.defaultRoute, route);
      const workflowInput = payload.workflowRoutes && typeof payload.workflowRoutes === 'object'
        ? payload.workflowRoutes
        : {};
      const nextConfig = cfgMod.loadConfig();
      let presets = Array.isArray(nextConfig.presets) ? nextConfig.presets.slice() : [];
      const workflowRoutes = { ...(nextConfig.workflowRoutes || {}) };

      if (defaultRoute) {
        presets = upsertWorkflowPreset(presets, 'lead', defaultRoute);
        workflowRoutes.lead = defaultRoute;
        nextConfig.default = workflowPresetId('lead');
      }

      for (const slot of WORKFLOW_ROUTE_SLOTS) {
        const normalized = normalizeWorkflowRoute(workflowInput[slot]);
        if (!normalized) continue;
        workflowRoutes[slot] = normalized;
        presets = upsertWorkflowPreset(presets, slot, normalized);
      }

      nextConfig.presets = presets;
      nextConfig.workflowRoutes = workflowRoutes;
      nextConfig.maintenance = {
        ...(nextConfig.maintenance || {}),
        explore: workflowRoutes.explorer ? workflowPresetId('explorer') : (nextConfig.maintenance?.explore || 'haiku'),
        memory: workflowRoutes.memory ? workflowPresetId('memory') : (nextConfig.maintenance?.memory || 'haiku'),
      };
      nextConfig.onboarding = {
        ...(nextConfig.onboarding || {}),
        completed: true,
        version: ONBOARDING_VERSION,
        completedAt: new Date().toISOString(),
      };

      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      if (defaultRoute) {
        route = resolveRoute(config, { provider: defaultRoute.provider, model: defaultRoute.model, effort: defaultRoute.effort });
        if (session?.id) mgr.closeSession(session.id, 'cli-onboarding-complete');
        await createCurrentSession();
      }
      return this.getOnboardingStatus();
    },
    getChannelSetup() {
      return channelSetup();
    },
    getChannelWorkerStatus() {
      return channels.status();
    },
    saveDiscordToken(token) {
      const result = saveDiscordToken(token);
      reloadChannelsSoon();
      return result;
    },
    forgetDiscordToken() {
      const result = forgetDiscordToken();
      reloadChannelsSoon();
      return result;
    },
    saveWebhookAuthtoken(token) {
      const result = saveWebhookAuthtoken(token);
      reloadChannelsSoon();
      return result;
    },
    forgetWebhookAuthtoken() {
      const result = forgetWebhookAuthtoken();
      reloadChannelsSoon();
      return result;
    },
    saveChannel(entry) {
      const result = saveChannel(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteChannel(name) {
      const result = deleteChannel(name);
      reloadChannelsSoon();
      return result;
    },
    setWebhookConfig(patch) {
      const result = setWebhookConfig(patch);
      reloadChannelsSoon();
      return result;
    },
    saveSchedule(entry) {
      const result = saveSchedule(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteSchedule(name) {
      const result = deleteSchedule(name);
      reloadChannelsSoon();
      return result;
    },
    saveWebhook(entry) {
      const result = saveWebhook(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteWebhook(name) {
      const result = deleteWebhook(name);
      reloadChannelsSoon();
      return result;
    },
    async authenticateProvider(providerId, secret) {
      const result = String(secret || '').trim()
        ? saveProviderApiKey(cfgMod, providerId, secret)
        : await loginOAuthProvider(cfgMod, providerId);
      config = cfgMod.loadConfig();
      return result;
    },
    async loginOAuthProvider(providerId) {
      const result = await loginOAuthProvider(cfgMod, providerId);
      config = cfgMod.loadConfig();
      return result;
    },
    saveProviderApiKey(providerId, secret) {
      const result = saveProviderApiKey(cfgMod, providerId, secret);
      config = cfgMod.loadConfig();
      return result;
    },
    setLocalProvider(providerId, opts) {
      const result = setLocalProvider(cfgMod, providerId, opts);
      config = cfgMod.loadConfig();
      return result;
    },
    forgetProviderAuth(providerId) {
      const result = forgetProviderAuth(providerId);
      config = cfgMod.loadConfig();
      return result;
    },
    listPresets() {
      return cfgMod.listPresets(cfgMod.loadConfig());
    },
    async listProviderModels() {
      await reg.initProviders(config.providers || {});
      const allProviders = reg.getAllProviders();
      const results = [];
      const seen = new Set();
      for (const [name, provider] of allProviders) {
        if (typeof provider?.listModels !== 'function') continue;
        try {
          const models = await provider.listModels();
          if (Array.isArray(models)) {
            for (const m of models) {
              if (!m?.id) continue;
              const key = `${name}:${m.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              results.push({
                id: m.id,
                provider: name,
                display: m.display || m.name || m.id,
                contextWindow: m.contextWindow,
                outputTokens: m.outputTokens || null,
                family: m.family || null,
                tier: m.tier || null,
                latest: m.latest === true,
                description: m.description || '',
                supportsVision: m.supportsVision === true,
                supportsFunctionCalling: m.supportsFunctionCalling === true,
                supportsPromptCaching: m.supportsPromptCaching === true,
                reasoningLevels: Array.isArray(m.reasoningLevels) ? m.reasoningLevels : [],
                effortOptions: effortItemsFor(name, m, null),
              });
            }
          }
        } catch {
          // Ignore per-provider catalog failures so one bad credential or
          // transient /models error does not hide other authenticated models.
        }
      }
      results.sort((a, b) => {
        const ar = a.provider === route.provider ? 0 : 1;
        const br = b.provider === route.provider ? 0 : 1;
        if (ar !== br) return ar - br;
        if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
        if (a.latest !== b.latest) return a.latest ? -1 : 1;
        return String(a.display || a.id).localeCompare(String(b.display || b.id));
      });
      return results;
    },
    async ask(prompt, options = {}) {
      if (!session?.id) await createCurrentSession();
      const startedAt = Date.now();
      hooks.emit('turn:start', { sessionId: session.id, prompt, cwd: currentCwd });
      try {
        const result = await mgr.askSession(
          session.id,
          prompt,
          options.context || null,
          async (iter, calls) => {
            for (const call of calls || []) {
              hooks.emit('tool:planned', {
                sessionId: session.id,
                name: call?.name || 'tool',
                callId: call?.id || null,
              });
            }
            if (typeof options.onToolCall === 'function') {
              return await options.onToolCall(iter, calls);
            }
            return undefined;
          },
          currentCwd,
          options.prefetch || null,
          {
            onTextDelta: options.onTextDelta,
            onReasoningDelta: options.onReasoningDelta,
            onUsageDelta: options.onUsageDelta,
            onStageChange: options.onStageChange,
            onStreamDelta: options.onStreamDelta,
          },
        );
        session = mgr.getSession(session.id) || session;
        hooks.emit('turn:end', { sessionId: session.id, elapsedMs: Date.now() - startedAt });
        return { result, session };
      } catch (error) {
        hooks.emit('turn:error', { sessionId: session?.id || null, elapsedMs: Date.now() - startedAt, error: error?.message || String(error) });
        throw error;
      }
    },
    async clear() {
      if (!session?.id) return false;
      return await mgr.clearSessionMessages(session.id);
    },
    async compact() {
      if (!session?.id) return null;
      const result = await mgr.compactSessionMessages(session.id);
      session = mgr.getSession(session.id) || session;
      return result;
    },
    async setToolMode(nextMode) {
      mode = normalizeToolMode(nextMode);
      if (session?.id) mgr.closeSession(session.id, 'cli-mode-switch');
      await createCurrentSession();
      return mode;
    },
    setBridgeMode(nextMode) {
      return bridge.setDefaultMode(nextMode);
    },
    toggleBridgeMode() {
      return bridge.toggleDefaultMode();
    },
    bridgeControl(args = {}) {
      return bridge.execute(args, { callerCwd: currentCwd });
    },
    toolsStatus(query = '') {
      const catalog = Array.isArray(session?.deferredToolCatalog)
        ? session.deferredToolCatalog
        : (Array.isArray(session?.tools) ? session.tools : []);
      const activeNames = new Set((session?.tools || []).map((tool) => tool?.name).filter(Boolean));
      const needle = clean(query).toLowerCase();
      const rows = catalog.map((tool) => toolRow(tool, activeNames)).filter((row) => row.name);
      const tools = needle
        ? rows.filter((row) => `${row.name} ${row.kind} ${row.description} ${row.active ? 'active' : 'deferred'}`.toLowerCase().includes(needle))
        : rows;
      return {
        mode,
        count: rows.length,
        activeCount: rows.filter((row) => row.active).length,
        tools,
        activeTools: sortedNamesByMeasuredUsage(activeNames),
      };
    },
    selectTools(names) {
      const list = Array.isArray(names) ? names : String(names || '').split(/[,\s]+/);
      const result = selectDeferredTools(session, list, mode);
      return { ...result, status: this.toolsStatus() };
    },
    setCwd(path) {
      currentCwd = resolveCwdPath(currentCwd, path);
      process.env.MIXDOG_SESSION_CWD = currentCwd;
      writeLastSessionCwd(currentCwd);
      if (session) session.cwd = currentCwd;
      return currentCwd;
    },
    mcpStatus() {
      return mcpStatus();
    },
    async reconnectMcp() {
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-reconnect');
      await createCurrentSession();
      return status;
    },
    async removeMcpServer(name) {
      const serverName = clean(name);
      if (!serverName) throw new Error('MCP server name is required');
      const nextConfig = cfgMod.loadConfig();
      const current = nextConfig.mcpServers && typeof nextConfig.mcpServers === 'object'
        ? { ...nextConfig.mcpServers }
        : {};
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) {
        throw new Error(`MCP server not configured: ${serverName}`);
      }
      delete current[serverName];
      cfgMod.saveConfig({ ...nextConfig, mcpServers: current });
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      if (session?.id) mgr.closeSession(session.id, 'cli-mcp-remove');
      await createCurrentSession();
      return status;
    },
    skillsStatus() {
      return skillsStatus();
    },
    skillContent(name) {
      return skillContent(name);
    },
    async reloadSkills() {
      if (session?.id) mgr.closeSession(session.id, 'cli-skills-reload');
      await createCurrentSession();
      return skillsStatus();
    },
    pluginsStatus() {
      return pluginsStatus();
    },
    async reloadPlugins() {
      if (session?.id) mgr.closeSession(session.id, 'cli-plugins-reload');
      await createCurrentSession();
      return pluginsStatus();
    },
    async enablePluginMcp(plugin = {}) {
      const root = clean(plugin.root);
      const script = clean(plugin.mcpScript);
      if (!root || !script) throw new Error('plugin has no MCP script');
      const scriptPath = join(root, script);
      if (!existsSync(scriptPath)) throw new Error(`plugin MCP script not found: ${scriptPath}`);
      const serverName = pluginMcpServerName(plugin);
      const nextConfig = cfgMod.loadConfig();
      nextConfig.mcpServers = {
        ...(nextConfig.mcpServers || {}),
        [serverName]: {
          command: 'node',
          args: [scriptPath],
          cwd: root,
          env: {
            CLAUDE_PLUGIN_ROOT: root,
            CLAUDE_PLUGIN_DATA: join(homedir(), '.claude', 'plugins', 'data', `${clean(plugin.name || serverName)}-${clean(plugin.marketplace || plugin.source || 'local')}`),
          },
        },
      };
      cfgMod.saveConfig(nextConfig);
      config = cfgMod.loadConfig();
      const status = await connectConfiguredMcp({ reset: true });
      if (session?.id) mgr.closeSession(session.id, 'cli-plugin-mcp-enable');
      await createCurrentSession();
      return { serverName, status };
    },
    hooksStatus() {
      return hooks.status();
    },
    addHookRule(rule) {
      return hooks.addRule(rule);
    },
    setHookRuleEnabled(index, enabled) {
      return hooks.setRuleEnabled(index, enabled);
    },
    deleteHookRule(index) {
      return hooks.deleteRule(index);
    },
    async memoryControl(args = {}) {
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      return toolResponseText(await memoryMod.handleToolCall('memory', args || {}));
    },
    async recall(query, args = {}) {
      const memoryMod = await getMemoryModule();
      if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
      return toolResponseText(await memoryMod.handleToolCall('recall', {
        ...(args || {}),
        query: query || args?.query || '',
        cwd: args?.cwd || currentCwd,
      }));
    },
    async setRoute(next) {
      const requested = { ...(next || {}) };
      if (requested.effort === undefined && hasOwn(route, 'effort')) {
        requested.effort = route.effort;
      }
      if (!requested.provider && requested.model && !findPreset(config, requested.model)) {
        requested.provider = route.provider;
      }
      route = resolveRoute(config, requested);
      if (session?.id) mgr.closeSession(session.id, 'cli-model-switch');
      await createCurrentSession();
      return route;
    },

    async setEffort(value) {
      const normalized = normalizeEffortInput(value);
      route = { ...route, effort: normalized };
      await refreshRouteEffort();
      if (session) {
        session.effort = route.effectiveEffort || null;
        statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
      }
      return route;
    },
    close(reason = 'cli-exit') {
      channels.stop(reason);
      bridge.closeAll(reason);
      mcpClient.disconnectAll?.().catch(() => {});
      if (!session?.id) return false;
      statusRoutes?.clearGatewaySessionRoute?.(session.id);
      const ok = mgr.closeSession(session.id, reason);
      session = null;
      return ok;
    },
    abort(reason = 'cli-abort') {
      if (!session?.id) return false;
      statusRoutes?.clearGatewaySessionRoute?.(session.id);
      const ok = mgr.closeSession(session.id, reason);
      session = null;
      return ok;
    },
    listSessions() {
      return mgr.listSessions({}).map(s => {
        const msgs = s.messages || [];
        const firstUser = msgs.find(m => m && m.role === 'user');
        const preview = firstUser
          ? (typeof firstUser.content === 'string'
              ? firstUser.content.slice(0, 120)
              : '(non-text)')
          : '';
        const userAsst = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant'));
        return {
          id: s.id,
          updatedAt: s.updatedAt,
          model: s.model,
          provider: s.provider,
          messageCount: userAsst.length,
          preview,
        };
      });
    },
    async newSession() {
      if (session?.id) mgr.closeSession(session.id, 'cli-new');
      await createCurrentSession();
      return session.id;
    },
    async resume(id) {
      const previousId = session?.id || null;
      const resumed = await mgr.resumeSession(id, toolSpecForMode(mode));
      if (!resumed) return null;
      if (previousId && previousId !== resumed.id) {
        statusRoutes?.clearGatewaySessionRoute?.(previousId);
        mgr.closeSession(previousId, 'cli-resume');
      }
      session = resumed;
      const resumeEffort = hasOwn(route, 'effort') ? route.effort : resumed.effort;
      route = resolveRoute(config, { provider: resumed.provider, model: resumed.model, effort: resumeEffort });
      await refreshRouteEffort();
      session.effort = route.effectiveEffort || null;
      statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
      return {
        id: resumed.id,
        messages: resumed.messages || [],
        provider: resumed.provider,
        model: resumed.model,
      };
    },
  };
}
