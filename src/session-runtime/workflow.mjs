// Workflow/agent pack loading + route resolution, and search-route
// normalization. Roots/dataDir and config-dependent helpers are injected to
// keep this module free of the runtime's path/provider constants.
import { basename, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { clean } from './session-text.mjs';
import { normalizeEffortInput } from './effort.mjs';
import { isLikelyRawModelId } from './config-helpers.mjs';
import { readTextSafe, readJsonSafe } from './fs-utils.mjs';
import { isHiddenAgent } from '../runtime/agent/orchestrator/internal-agents.mjs';

export const WORKFLOW_ROUTE_SLOTS = ['lead', 'agent', 'explorer', 'memory'];
export const FIXED_AGENT_SLOTS = Object.freeze([
  // Short one-liners on purpose: these render inside the 260px sidebar rail
  // (user: 창이 크지 않으니 설명은 짧게).
  { id: 'explore', label: 'Explore', description: 'Repository exploration', workflowSlot: 'explorer' },
  { id: 'maintainer', label: 'Maintainer', description: 'Memory and upkeep', workflowSlot: 'memory' },
  { id: 'worker', label: 'Worker', description: 'Simple tasks' },
  { id: 'heavy-worker', label: 'Heavy Worker', description: 'Complex tasks' },
  { id: 'reviewer', label: 'Reviewer', description: 'Diff and risk review' },
  { id: 'debugger', label: 'Debugger', description: 'Root-cause debugging' },
]);
const AGENT_ROLE_IDS = new Set(FIXED_AGENT_SLOTS.map((agent) => agent.id));
// Slot-backed built-ins (explore/maintainer) run through their own dedicated
// channels — the explore tool and the memory cycle — so they are never
// Lead-delegation targets and stay out of the Available Agents catalog.
const BUILTIN_SLOT_AGENT_IDS = new Set(
  FIXED_AGENT_SLOTS.filter((agent) => agent.workflowSlot).map((agent) => agent.id),
);
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

// Editor writes must invalidate the definition cache or a saved AGENT.md
// stays stale for the session lifetime (keys are `${dir}\n${agentId}`).
export function clearAgentDefinitionCache(agentId = '') {
  if (!agentId) {
    agentDefinitionCache.clear();
    return;
  }
  for (const key of [...agentDefinitionCache.keys()]) {
    if (key.endsWith(`\n${agentId}`)) agentDefinitionCache.delete(key);
  }
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

function internalIdFromName(value, fallbackPrefix) {
  const name = clean(value);
  const readable = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  const id = normalizeWorkflowId(readable, '');
  if (id) return id;
  return `${fallbackPrefix}-${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
}

export function workflowIdFromName(value) {
  return internalIdFromName(value, 'workflow');
}

export function agentIdFromName(value) {
  return internalIdFromName(value, 'agent');
}

export function availableWorkflowId(baseId, isTaken) {
  const id = normalizeWorkflowId(baseId, '');
  if (!id) return '';
  if (!isTaken(id)) return id;
  let suffix = 2;
  while (isTaken(`${id}-${suffix}`)) suffix += 1;
  return `${id}-${suffix}`;
}

export function availableAgentId(name, isTaken) {
  return availableWorkflowId(agentIdFromName(name), isTaken);
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

  // Custom agents (user-authored roles beyond FIXED_AGENT_SLOTS): every
  // agents/<id>/AGENT.md directory whose id is not a fixed role. Mixdog-managed
  // hidden roles (defaults/agents.json: scheduler-task, webhook-handler, …) ship
  // the same directory layout, so they are excluded here — at the data source —
  // instead of per-surface, or the TUI /agents list exposes internal roles the
  // desktop UI happens to filter out.
  function listCustomAgentIds(dir) {
    const ids = new Set();
    for (const root of [join(dir || dataDir, 'agents'), join(rootDir, 'agents')]) {
      if (!existsSync(root)) continue;
      let entries = [];
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const id = normalizeWorkflowId(entry.name);
        if (!id || AGENT_ROLE_IDS.has(id) || isHiddenAgent(id)) continue;
        if (!existsSync(join(root, entry.name, 'AGENT.md'))) continue;
        ids.add(id);
      }
    }
    return [...ids].sort();
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
    // Solo leads (user decision: solo is the default working mode), the
    // cowork pack (built-in id `default`) second, then customs alphabetically
    // — every picker (TUI, desktop sidebar, onboarding) shares this order.
    const weight = (pack) => pack.id === 'solo' ? 0
      : (pack.id === DEFAULT_WORKFLOW_ID || pack.id === 'cowork') ? 1 : 2;
    return [...byId.values()].sort((a, b) =>
      (weight(a) - weight(b)) || a.name.localeCompare(b.name));
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
      // Delegation surface fields: the session stores this summary as
      // session.workflow, and the agent-tool gate (tool-surface.mjs
      // workflowAllowsAgents) needs them to filter the agent tool for
      // packs that delegate to nobody — including headless/bench sessions
      // whose workflow never touches the config-active pack.
      agentsConfigured: pack?.agentsConfigured === true,
      agents: Array.isArray(pack?.agents) ? pack.agents.slice() : [],
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
    // Every shipped and user role lives at agents/<id>/AGENT.md; there is no
    // flat agents/<id>.md layout left to fall back to.
    setAgentDefinitionCache(cacheKey, null);
    return null;
  }

  function workflowContextBlock(config, dir) {
    return workflowContextBlockFromPack(loadWorkflowPack(dir, activeWorkflowId(config)), dir);
  }

  function workflowContextBlockFromPack(pack, dir) {
    if (!pack) return '';
    // The pack body opens with its own `# <name>` title, so header + description
    // + body used to repeat the workflow name three times in the prompt. Emit one
    // header line and drop the body's duplicate title (only when it matches).
    const rawBody = String(pack.body || '');
    const firstBreak = rawBody.indexOf('\n');
    const firstLine = (firstBreak === -1 ? rawBody : rawBody.slice(0, firstBreak)).trim();
    const body = firstBreak !== -1 && firstLine.toLowerCase() === `# ${String(pack.name || '').toLowerCase()}`
      ? rawBody.slice(firstBreak + 1).replace(/^\s+/, '')
      : rawBody;
    const lines = [`# Active Workflow: ${pack.name}${pack.description ? ` — ${pack.description}` : ''}`, body];
    // A hand-edited pack may name a hidden role in its `agents:` frontmatter;
    // internal roles are never delegatable, so they never enter the catalog.
    // Slot-backed built-ins are equally non-delegatable (they ride the explore
    // tool / memory cycle), so they are filtered even when a pack names them.
    const agentIds = (pack.agentsConfigured ? pack.agents : FIXED_AGENT_SLOTS.map((agent) => agent.id))
      .filter((id) => !isHiddenAgent(id) && !BUILTIN_SLOT_AGENT_IDS.has(id));
    const agentBlocks = agentIds.map((id) => loadAgentDefinition(dir, id)).filter(Boolean);
    if (agentBlocks.length) {
      lines.push('# Available Agents');
      // Name + description only: the AGENT.md body is the worker's own system
      // prompt and rides in the worker session at spawn time — repeating it in
      // the Lead prompt only bloats context. Lead picks agents by description
      // (a when-to-use signal); the workflow body carries the rules.
      lines.push(agentBlocks
        .map((agent) => `- ${agent.name} (${agent.id})${agent.description ? `: ${agent.description}` : ''}`)
        .join('\n'));
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
    listCustomAgentIds,
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
    // Custom agents (user-authored roles) pass through as workflow-style ids;
    // their routes live in config.agents[<id>] like the fixed roles.
    const id = normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
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
