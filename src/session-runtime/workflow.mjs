// Workflow/agent pack loading + route resolution, and search-route
// normalization. Roots/dataDir and config-dependent helpers are injected to
// keep this module free of the runtime's path/provider constants.
import { basename, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { clean } from './session-text.mjs';
import { normalizeEffortInput } from './effort.mjs';
import { isLikelyRawModelId } from './config-helpers.mjs';
import { readTextSafe, readJsonSafe } from './fs-utils.mjs';

export const WORKFLOW_ROUTE_SLOTS = ['lead', 'agent', 'explorer', 'memory'];
export const FIXED_AGENT_SLOTS = Object.freeze([
  { id: 'explore', label: 'Explore', description: 'Broad repository exploration', workflowSlot: 'explorer' },
  { id: 'maintainer', label: 'Maintainer', description: 'Background memory and upkeep', workflowSlot: 'memory' },
  { id: 'worker', label: 'Worker', description: 'Scoped implementation' },
  { id: 'heavy-worker', label: 'Heavy Worker', description: 'Broad or multi-file implementation' },
  { id: 'reviewer', label: 'Reviewer', description: 'Diff review and risk checks' },
  { id: 'debugger', label: 'Debugger', description: 'Root-cause analysis and failure tracing' },
]);
const AGENT_ROLE_IDS = new Set(FIXED_AGENT_SLOTS.map((agent) => agent.id));
export const DEFAULT_WORKFLOW_ID = 'default';

const SEARCH_CAPABLE_PROVIDERS = new Set([
  'openai-oauth', 'openai', 'grok-oauth', 'xai', 'gemini', 'anthropic', 'anthropic-oauth',
]);
export const SEARCH_DEFAULT_PROVIDER = 'default';
export const SEARCH_DEFAULT_MODEL = 'default';
const SEARCH_PROVIDER_ALIASES = Object.freeze({
  'openai-api': 'openai',
  'xai-api': 'xai',
  'gemini-api': 'gemini',
  'anthropic-api': 'anthropic',
});

const agentDefinitionCache = new Map();
const AGENT_DEFINITION_CACHE_LIMIT = 64;
function setAgentDefinitionCache(key, value) {
  if (!agentDefinitionCache.has(key) && agentDefinitionCache.size >= AGENT_DEFINITION_CACHE_LIMIT) {
    const oldestKey = agentDefinitionCache.keys().next().value;
    agentDefinitionCache.delete(oldestKey);
  }
  agentDefinitionCache.set(key, value);
}

export function workflowPresetId(slot) {
  return `workflow-${slot}`;
}

function workflowPresetName(slot) {
  return `WORKFLOW ${String(slot || '').toUpperCase()}`;
}

export function agentPresetSlot(agentId) {
  return `agent-${String(agentId || '').replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase()}`;
}

export function normalizeAgentId(value) {
  const id = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (id === 'explorer') return 'explore';
  if (id === 'maint' || id === 'maintenance' || id === 'memory') return 'maintainer';
  if (id === 'heavy' || id === 'heavyworker') return 'heavy-worker';
  if (id === 'review') return 'reviewer';
  if (id === 'debug') return 'debugger';
  return AGENT_ROLE_IDS.has(id) ? id : '';
}

export function normalizeWorkflowId(value, fallback = '') {
  const id = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  return /^[a-z0-9][a-z0-9_.-]*$/.test(id) ? id : fallback;
}

// A workflow/agent pack loader is created per data/root layout via
// createWorkflowHelpers, and the config-aware route helpers via
// createWorkflowRouteHelpers.
export function createWorkflowHelpers({ rootDir, dataDir, readMarkdownDocument, normalizeAgentPermissionOrNone }) {
  function workflowSourceDirs(dir) {
    return [
      { root: join(rootDir, 'workflows'), source: 'built-in' },
      { root: join(dir || dataDir, 'workflows'), source: 'user' },
    ];
  }

  function agentSourceDirs(dir, id) {
    return [
      join(dir || dataDir, 'agents', id),
      join(rootDir, 'agents', id),
    ];
  }

  function readWorkflowPackFromDir(dir, source = 'built-in', dirName = '') {
    const entry = 'WORKFLOW.md';
    const doc = readMarkdownDocument(readTextSafe(join(dir, entry)));
    const body = doc.body;
    if (!body) return null;
    const fm = doc.frontmatter || {};
    const id = normalizeWorkflowId(clean(fm.id) || dirName || basename(dir));
    if (!id) return null;
    const agentsConfigured = Object.prototype.hasOwnProperty.call(fm, 'agents');
    return {
      id,
      name: clean(fm.name) || id,
      description: clean(fm.description),
      entry,
      hidden: String(fm.hidden ?? '').trim().toLowerCase() === 'true',
      agentsConfigured,
      agents: agentsConfigured
        ? String(fm.agents || '')
            .split(',')
            .map((agent) => normalizeAgentId(agent) || normalizeWorkflowId(agent))
            .filter(Boolean)
        : [],
      body,
      source,
    };
  }

  function listWorkflowPacks(dir) {
    const byId = new Map();
    for (const { root, source } of workflowSourceDirs(dir)) {
      if (!existsSync(root)) continue;
      let entries = [];
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const d = join(root, entry.name);
        if (!existsSync(join(d, 'WORKFLOW.md'))) continue;
        const pack = readWorkflowPackFromDir(d, source, entry.name);
        if (pack && !pack.hidden) byId.set(pack.id, pack);
      }
    }
    return [...byId.values()].sort((a, b) => {
      if (a.id === DEFAULT_WORKFLOW_ID) return -1;
      if (b.id === DEFAULT_WORKFLOW_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  function activeWorkflowId(config) {
    return normalizeWorkflowId(config?.workflow?.active, DEFAULT_WORKFLOW_ID);
  }

  function loadWorkflowPack(dir, id) {
    const wanted = normalizeWorkflowId(id, DEFAULT_WORKFLOW_ID);
    for (const { root, source } of workflowSourceDirs(dir).reverse()) {
      const pack = readWorkflowPackFromDir(join(root, wanted), source, wanted);
      if (pack) return pack;
    }
    return readWorkflowPackFromDir(join(rootDir, 'workflows', DEFAULT_WORKFLOW_ID), 'built-in', DEFAULT_WORKFLOW_ID);
  }

  function workflowSummary(pack) {
    const id = normalizeWorkflowId(pack?.id, DEFAULT_WORKFLOW_ID);
    return {
      id,
      name: clean(pack?.name) || (id === DEFAULT_WORKFLOW_ID ? 'Default' : id),
      description: clean(pack?.description),
      source: clean(pack?.source),
    };
  }

  function activeWorkflowSummary(config, dir) {
    return workflowSummary(loadWorkflowPack(dir, activeWorkflowId(config)));
  }

  function loadAgentDefinition(dir, id) {
    const agentId = normalizeAgentId(id) || normalizeWorkflowId(id);
    if (!agentId) return null;
    const cacheKey = `${dir || dataDir}\n${agentId}`;
    if (agentDefinitionCache.has(cacheKey)) return agentDefinitionCache.get(cacheKey);
    for (const d of agentSourceDirs(dir, agentId)) {
      const manifest = readJsonSafe(join(d, 'agent.json')) || {};
      const entry = clean(manifest.entry) || 'AGENT.md';
      const doc = readMarkdownDocument(readTextSafe(join(d, entry)));
      const body = doc.body;
      if (!body) continue;
      const definition = {
        id: agentId,
        name: clean(manifest.name) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.label || agentId,
        description: clean(manifest.description) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.description || '',
        permission: normalizeAgentPermissionOrNone(doc.frontmatter.permission),
        frontmatter: doc.frontmatter,
        body,
      };
      setAgentDefinitionCache(cacheKey, definition);
      return definition;
    }
    const legacyDoc = readMarkdownDocument(readTextSafe(join(rootDir, 'agents', `${agentId}.md`)));
    if (!legacyDoc.body) {
      setAgentDefinitionCache(cacheKey, null);
      return null;
    }
    const definition = {
      id: agentId,
      name: FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.label || agentId,
      description: '',
      permission: normalizeAgentPermissionOrNone(legacyDoc.frontmatter.permission),
      frontmatter: legacyDoc.frontmatter,
      body: legacyDoc.body,
    };
    setAgentDefinitionCache(cacheKey, definition);
    return definition;
  }

  function workflowContextBlock(config, dir) {
    return workflowContextBlockFromPack(loadWorkflowPack(dir, activeWorkflowId(config)), dir);
  }

  function workflowContextBlockFromPack(pack, dir) {
    if (!pack) return '';
    const lines = [`# Active Workflow: ${pack.name}`];
    if (pack.description) lines.push(pack.description);
    lines.push(pack.body);
    const agentIds = pack.agentsConfigured ? pack.agents : FIXED_AGENT_SLOTS.map((agent) => agent.id);
    const agentBlocks = agentIds.map((id) => loadAgentDefinition(dir, id)).filter(Boolean);
    if (agentBlocks.length) {
      lines.push('# Available Agents');
      for (const agent of agentBlocks) {
        lines.push(`## ${agent.name} (${agent.id})`);
        if (agent.description) lines.push(agent.description);
        lines.push(agent.body);
      }
    }
    return lines.join('\n\n');
  }

  // Single-pass variant: loads the active WORKFLOW.md pack once and derives both
  // the summary and the context block from it, so session-create does not re-read
  // and re-parse WORKFLOW.md twice on the hot boot path.
  function activeWorkflowContext(config, dir) {
    const pack = loadWorkflowPack(dir, activeWorkflowId(config));
    return {
      summary: workflowSummary(pack),
      context: workflowContextBlockFromPack(pack, dir),
    };
  }

  return {
    listWorkflowPacks,
    activeWorkflowId,
    loadWorkflowPack,
    workflowSummary,
    activeWorkflowSummary,
    loadAgentDefinition,
    workflowContextBlock,
    activeWorkflowContext,
  };
}

export function normalizeSearchProviderId(provider) {
  const id = clean(provider);
  return SEARCH_PROVIDER_ALIASES[id] || id;
}

export function isDefaultSearchRouteConfig(routeLike = {}) {
  return normalizeSearchProviderId(routeLike?.provider) === SEARCH_DEFAULT_PROVIDER
    && clean(routeLike?.model).toLowerCase() === SEARCH_DEFAULT_MODEL;
}

export function isSearchCapableProvider(provider) {
  return SEARCH_CAPABLE_PROVIDERS.has(normalizeSearchProviderId(provider));
}

export function normalizeSearchRouteConfig(routeLike, fallback = {}) {
  const provider = normalizeSearchProviderId(routeLike?.provider || fallback.provider);
  const model = clean(routeLike?.model || fallback.model);
  if (!provider || !model) return null;
  let effort = null;
  try {
    effort = normalizeEffortInput(routeLike?.effort ?? fallback.effort);
  } catch {
    effort = null;
  }
  const fast = routeLike?.fast ?? fallback.fast;
  const toolType = clean(routeLike?.toolType || fallback.toolType);
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(fast === true ? { fast: true } : {}),
    ...(toolType ? { toolType } : {}),
  };
}

export function normalizeWorkflowRoute(routeLike, fallback = {}) {
  const provider = clean(routeLike?.provider) || clean(fallback.provider);
  const model = clean(routeLike?.model) || clean(fallback.model);
  if (!provider || !model) return null;
  // Defensive: a workflow/agent route must carry a real model id. Reject values
  // that are obviously free-form text (whitespace, prose) so a bad string can
  // never be persisted as a preset/workflow route.
  if (!isLikelyRawModelId(model)) return null;
  const effort = normalizeEffortInput(routeLike?.effort ?? fallback.effort);
  const fast = routeLike?.fast ?? fallback.fast;
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(fast === true ? { fast: true } : {}),
  };
}

export function upsertWorkflowPreset(presets, slot, routeLike) {
  const route = normalizeWorkflowRoute(routeLike);
  if (!route) return presets;
  const id = workflowPresetId(slot);
  const preset = {
    id,
    name: workflowPresetName(slot),
    type: 'agent',
    provider: route.provider,
    model: route.model,
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.fast === true ? { fast: true } : {}),
    tools: 'full',
  };
  const next = (Array.isArray(presets) ? presets : []).filter((p) => clean(p?.id) !== id && clean(p?.name) !== preset.name);
  next.push(preset);
  return next;
}

// Config-aware route resolvers need resolveDefaultProvider + findPreset from
// the runtime; created via this factory.
export function createWorkflowRouteHelpers({ resolveDefaultProvider, findPreset }) {
  function summarizeWorkflowRoutes(config) {
    const routes = config?.workflowRoutes && typeof config.workflowRoutes === 'object' ? config.workflowRoutes : {};
    const fallbackProvider = resolveDefaultProvider(config);
    const out = {};
    for (const slot of WORKFLOW_ROUTE_SLOTS) {
      const route = routes[slot];
      // Read/interpret path: a route with a model but no provider falls back to
      // config.defaultProvider (then DEFAULT_PROVIDER).
      if (route?.model && (route?.provider || fallbackProvider)) {
        out[slot] = normalizeWorkflowRoute(route, { provider: fallbackProvider });
      }
    }
    return out;
  }

  function routeFromPreset(config, slotValue) {
    // Maintenance slots now store a direct {provider, model} route. Accept that
    // shape first; fall back to the legacy preset-NAME string lookup so configs
    // written before the route migration still resolve.
    if (slotValue && typeof slotValue === 'object' && !Array.isArray(slotValue)) {
      const direct = normalizeWorkflowRoute(slotValue);
      if (direct) return direct;
    }
    const preset = findPreset(config, slotValue);
    return preset ? normalizeWorkflowRoute(preset) : null;
  }

  function agentRouteFromConfig(config, agentId, _dataDir) {
    const id = normalizeAgentId(agentId);
    if (!id) return null;
    // Read/interpret path: inject config.defaultProvider (then DEFAULT_PROVIDER)
    // when a stored route omits its provider.
    const fallback = { provider: resolveDefaultProvider(config) };
    const explicit = normalizeWorkflowRoute(config?.agents?.[id], fallback)
      || (id === 'maintainer' ? normalizeWorkflowRoute(config?.agents?.maintenance, fallback) : null);
    if (explicit) return explicit;

    const agent = FIXED_AGENT_SLOTS.find((item) => item.id === id);
    if (agent?.workflowSlot) {
      const workflowRoute = normalizeWorkflowRoute(config?.workflowRoutes?.[agent.workflowSlot], fallback);
      if (workflowRoute) return workflowRoute;
    }

    if (id === 'explore') return routeFromPreset(config, config?.maintenance?.explore);
    if (id === 'maintainer') return routeFromPreset(config, config?.maintenance?.memory);

    return null;
  }

  return { summarizeWorkflowRoutes, routeFromPreset, agentRouteFromConfig };
}
