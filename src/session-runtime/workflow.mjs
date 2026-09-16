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
import { configuredOrchestrationMode } from '../runtime/shared/orchestration.mjs';
import { orchestrationInstructions } from './orchestration.mjs';
import {
  DEFAULT_DISABLED_AGENT_IDS,
  configuredAgentRouteCandidates,
  isAgentDisabled,
} from '../runtime/shared/agent-route-config.mjs';

export const WORKFLOW_ROUTE_SLOTS = ['lead', 'agent', 'memory'];
export const AGENT_DELETED_MARKER = '.deleted';
export const FIXED_AGENT_SLOTS = Object.freeze([
  // Short one-liners on purpose: these render inside the 260px sidebar rail
  // (user: 창이 크지 않으니 설명은 짧게).
  { id: 'maintainer', label: 'Maintainer', description: 'Memory and upkeep', workflowSlot: 'memory' },
]);
const AGENT_ROLE_IDS = new Set(FIXED_AGENT_SLOTS.map((agent) => agent.id));
// Slot-backed built-ins run through dedicated maintenance channels, so they are never
// Lead-delegation targets and stay out of the Available Agents catalog.
const BUILTIN_SLOT_AGENT_IDS = new Set(
  FIXED_AGENT_SLOTS.filter((agent) => agent.workflowSlot).map((agent) => agent.id)
);
const STARTER_AGENT_ORDER = new Map(DEFAULT_DISABLED_AGENT_IDS.map((id, index) => [id, index]));
export const DEFAULT_WORKFLOW_ID = 'default';

const WEB_SEARCH_CAPABLE_PROVIDERS = new Set([
  'openai-oauth',
  'openai',
  'grok-oauth',
  'xai',
  'gemini',
  'anthropic',
  'anthropic-oauth',
]);
export const WEB_SEARCH_DEFAULT_PROVIDER = 'default';
export const WEB_SEARCH_DEFAULT_MODEL = 'default';
const WEB_SEARCH_PROVIDER_ALIASES = Object.freeze({
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

export function normalizeAgentId(value) {
  const id = clean(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (id === 'maint' || id === 'maintenance' || id === 'memory') return 'maintainer';
  return AGENT_ROLE_IDS.has(id) ? id : '';
}

export function normalizeWorkflowId(value, fallback = '') {
  const id = clean(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return /^[a-z0-9][a-z0-9_.-]*$/.test(id) ? id : fallback;
}

// Persist the effective agent capability alongside workflow display metadata.
// This is derived from orchestration and available agents, never pack policy.
export function toSessionWorkflowMeta(workflow) {
  if (!workflow || typeof workflow !== 'object') return null;
  const id = String(workflow.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(workflow.name || id).trim(),
    description: String(workflow.description || '').trim(),
    source: String(workflow.source || '').trim(),
    delegatesAgents: workflow.delegatesAgents !== false,
  };
}

// Older sessions stored delegation policy here. Current summaries retain the
// effective capability so an empty agent catalog still removes the tool.
export function workflowDisallowsAgentTool(workflow) {
  if (!workflow || typeof workflow !== 'object') return false;
  if (workflow.delegatesAgents === false) return true;
  return Boolean(workflow.agentsConfigured === true && Array.isArray(workflow.agents) && workflow.agents.length === 0);
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

function agentIdFromName(value) {
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
    const userDir = join(dir || dataDir, 'agents', id);
    if (existsSync(join(userDir, AGENT_DELETED_MARKER))) return [userDir];
    return [userDir, join(rootDir, 'agents', id)];
  }

  // Custom agents include shipped starter roles and user-authored roles.
  // A data-dir tombstone suppresses a shipped starter after the user deletes it,
  // so package updates do not silently resurrect the role.
  function listCustomAgentIds(dir) {
    const ids = new Set();
    const userRoot = join(dir || dataDir, 'agents');
    for (const root of [userRoot, join(rootDir, 'agents')]) {
      if (!existsSync(root)) continue;
      let entries = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const id = normalizeWorkflowId(entry.name);
        if (!id || AGENT_ROLE_IDS.has(id) || isHiddenAgent(id)) continue;
        if (root !== userRoot && existsSync(join(userRoot, id, AGENT_DELETED_MARKER))) continue;
        if (!existsSync(join(root, entry.name, 'AGENT.md'))) continue;
        ids.add(id);
      }
    }
    return [...ids].sort((left, right) => {
      const leftRank = STARTER_AGENT_ORDER.get(left);
      const rightRank = STARTER_AGENT_ORDER.get(right);
      if (leftRank !== undefined || rightRank !== undefined) {
        return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
      }
      return left.localeCompare(right);
    });
  }

  function readWorkflowPackFromDir(dir, source = 'built-in', dirName = '') {
    const entry = 'WORKFLOW.md';
    const doc = readMarkdownDocument(readTextSafe(join(dir, entry)));
    const body = doc.body;
    if (!body) return null;
    const fm = doc.frontmatter || {};
    const id = normalizeWorkflowId(clean(fm.id) || dirName || basename(dir));
    if (!id) return null;
    return {
      id,
      name: clean(fm.name) || id,
      description: clean(fm.description),
      entry,
      hidden:
        String(fm.hidden ?? '')
          .trim()
          .toLowerCase() === 'true',
      body,
      source,
    };
  }

  function listWorkflowPacks(dir) {
    const byId = new Map();
    for (const { root, source } of workflowSourceDirs(dir)) {
      if (!existsSync(root)) continue;
      let entries = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const d = join(root, entry.name);
        if (!existsSync(join(d, 'WORKFLOW.md'))) continue;
        const pack = readWorkflowPackFromDir(d, source, entry.name);
        if (pack && !pack.hidden) byId.set(pack.id, pack);
      }
    }
    const weight = (pack) => (pack.id === DEFAULT_WORKFLOW_ID ? 0 : 1);
    return [...byId.values()].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name));
  }

  function activeWorkflowId(config) {
    const id = normalizeWorkflowId(config?.workflow?.active, DEFAULT_WORKFLOW_ID);
    return id === 'solo' ? DEFAULT_WORKFLOW_ID : id;
  }

  function loadWorkflowPack(dir, id) {
    const normalized = normalizeWorkflowId(id, DEFAULT_WORKFLOW_ID);
    const wanted = normalized === 'solo' ? DEFAULT_WORKFLOW_ID : normalized;
    for (const { root, source } of workflowSourceDirs(dir).reverse()) {
      const pack = readWorkflowPackFromDir(join(root, wanted), source, wanted);
      if (pack) return pack;
    }
    return readWorkflowPackFromDir(join(rootDir, 'workflows', DEFAULT_WORKFLOW_ID), 'built-in', DEFAULT_WORKFLOW_ID);
  }

  // Agents the Lead may actually delegate to: on disk, not hidden, not a
  // slot-backed built-in, and not switched off by the user.
  function delegatableAgentIds(config, dir) {
    return listCustomAgentIds(dir).filter(
      (id) => !isHiddenAgent(id) && !BUILTIN_SLOT_AGENT_IDS.has(id) && !isAgentDisabled(config, id)
    );
  }

  function workflowSummary(pack, { hasAgents = true, orchestrationMode = 'none' } = {}) {
    const id = normalizeWorkflowId(pack?.id, DEFAULT_WORKFLOW_ID);
    return {
      id,
      name: clean(pack?.name) || (id === 'default' ? 'Default' : id),
      description: clean(pack?.description),
      source: clean(pack?.source),
      // Effective session capability, not an editable workflow property.
      delegatesAgents: orchestrationMode !== 'none' && hasAgents !== false,
    };
  }

  function activeWorkflowSummary(config, dir) {
    return workflowSummary(loadWorkflowPack(dir, activeWorkflowId(config)), {
      hasAgents: delegatableAgentIds(config, dir).length > 0,
      orchestrationMode: configuredOrchestrationMode(config),
    });
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
        description:
          clean(manifest.description) || FIXED_AGENT_SLOTS.find((agent) => agent.id === agentId)?.description || '',
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
    return activeWorkflowContext(config, dir).context;
  }

  function workflowContextBlockFromPack(pack) {
    if (!pack) return '';
    // The pack body opens with its own `# <name>` title, so header + description
    // + body used to repeat the workflow name three times in the prompt. Emit one
    // header line and drop the body's duplicate title (only when it matches).
    const rawBody = String(pack.body || '');
    const firstBreak = rawBody.indexOf('\n');
    const firstLine = (firstBreak === -1 ? rawBody : rawBody.slice(0, firstBreak)).trim();
    const body =
      firstBreak !== -1 && firstLine.toLowerCase() === `# ${String(pack.name || '').toLowerCase()}`
        ? rawBody.slice(firstBreak + 1).replace(/^\s+/, '')
        : rawBody;
    const lines = [`# Active Workflow: ${pack.name}${pack.description ? ` — ${pack.description}` : ''}`, body];
    return lines.join('\n\n');
  }

  function orchestrationContextBlock(config, dir) {
    const instructions = orchestrationInstructions(configuredOrchestrationMode(config));
    if (!instructions) return '';
    const lines = [instructions];
    const agentIds = delegatableAgentIds(config, dir);
    const agentBlocks = agentIds.map((id) => loadAgentDefinition(dir, id)).filter(Boolean);
    if (agentBlocks.length) {
      lines.push('# Available Agents');
      // Name + description only: the AGENT.md body is the worker's own system
      // prompt and rides in the worker session at spawn time — repeating it in
      // the Lead prompt only bloats context. Lead picks agents by description
      // (a when-to-use signal); orchestration carries the delegation rules.
      lines.push(
        agentBlocks
          .map((agent) => `- ${agent.name} (${agent.id})${agent.description ? `: ${agent.description}` : ''}`)
          .join('\n')
      );
    }
    return lines.join('\n\n');
  }

  // Single-pass variant: loads the active WORKFLOW.md pack once and derives both
  // the summary and the context block from it, so session-create does not re-read
  // and re-parse WORKFLOW.md twice on the hot boot path.
  function activeWorkflowContext(config, dir) {
    const pack = loadWorkflowPack(dir, activeWorkflowId(config));
    const orchestrationMode = configuredOrchestrationMode(config);
    return {
      summary: workflowSummary(pack, { hasAgents: delegatableAgentIds(config, dir).length > 0, orchestrationMode }),
      orchestrationMode,
      context: [workflowContextBlockFromPack(pack), orchestrationContextBlock(config, dir)].filter(Boolean).join('\n\n'),
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
    delegatableAgentIds,
    workflowContextBlock,
    activeWorkflowContext,
  };
}

export function normalizeWebSearchProviderId(provider) {
  const id = clean(provider);
  return WEB_SEARCH_PROVIDER_ALIASES[id] || id;
}

export function isDefaultWebSearchRouteConfig(routeLike = {}) {
  return (
    normalizeWebSearchProviderId(routeLike?.provider) === WEB_SEARCH_DEFAULT_PROVIDER &&
    clean(routeLike?.model).toLowerCase() === WEB_SEARCH_DEFAULT_MODEL
  );
}

export function isWebSearchCapableProvider(provider) {
  return WEB_SEARCH_CAPABLE_PROVIDERS.has(normalizeWebSearchProviderId(provider));
}

export function normalizeWebSearchRouteConfig(routeLike, fallback = {}) {
  const provider = normalizeWebSearchProviderId(routeLike?.provider || fallback.provider);
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
  const modelParameters = routeLike?.modelParameters ?? fallback.modelParameters;
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof fast === 'boolean' ? { fast } : {}),
    ...(modelParameters && typeof modelParameters === 'object' ? { modelParameters: { ...modelParameters } } : {}),
    ...(toolType ? { toolType } : {}),
  };
}

// The runtime's web-search route is never "unconfigured": an unset or invalid
// candidate falls through to the next one, and an empty list resolves to the
// default "follow the Main Model" route.
export function webSearchRouteOrDefault(...routeLikes) {
  for (const routeLike of routeLikes) {
    const normalized = normalizeWebSearchRouteConfig(routeLike);
    if (normalized) return normalized;
  }
  return normalizeWebSearchRouteConfig({
    provider: WEB_SEARCH_DEFAULT_PROVIDER,
    model: WEB_SEARCH_DEFAULT_MODEL,
  });
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
  const modelParameters = routeLike?.modelParameters ?? fallback.modelParameters;
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof fast === 'boolean' ? { fast } : {}),
    ...(modelParameters && typeof modelParameters === 'object' ? { modelParameters: { ...modelParameters } } : {}),
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
    ...(route.modelParameters ? { modelParameters: route.modelParameters } : {}),
    tools: 'full',
  };
  const next = (Array.isArray(presets) ? presets : []).filter(
    (p) => clean(p?.id) !== id && clean(p?.name) !== preset.name
  );
  next.push(preset);
  return next;
}

// Config-aware route resolvers need findPreset from the runtime; created via
// this factory.
export function createWorkflowRouteHelpers({ findPreset }) {
  function summarizeWorkflowRoutes(config) {
    const out = {};
    const lead = routeFromPreset(config, config?.default);
    if (lead) out.lead = lead;
    for (const [slot, agentId] of [
      ['agent', 'worker'],
      ['memory', 'maintainer'],
    ]) {
      const route = agentRouteFromConfig(config, agentId);
      if (route) out[slot] = route;
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

  function agentRouteFromConfig(config, agentId) {
    // Custom agents (user-authored roles) pass through as workflow-style ids;
    // their routes live in config.agents[<id>] like the fixed roles.
    const id = normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
    if (!id) return null;
    for (const candidate of configuredAgentRouteCandidates(config, id)) {
      const route = normalizeWorkflowRoute(candidate) || routeFromPreset(config, candidate);
      if (route) return route;
    }
    return null;
  }

  return { summarizeWorkflowRoutes, routeFromPreset, agentRouteFromConfig };
}
