// Workflow/agent pack loading + route resolution, and search-route
// normalization. Roots/dataDir and config-dependent helpers are injected to
// keep this module free of the runtime's path/provider constants.
import { createHash } from 'node:crypto';
import { clean } from './session-text.mjs';
import { normalizeEffortInput } from './effort.mjs';
import { isLikelyRawModelId } from './config-helpers.mjs';
import { configuredAgentRouteCandidates } from '../runtime/shared/agent-route-config.mjs';
import { normalizeAgentId, normalizeWorkflowId } from './workflow-ids.mjs';
import { createWorkflowPacks } from './workflow/packs.mjs';
import { createWorkflowAgents } from './workflow/agents.mjs';
import { createWorkflowContext } from './workflow/context.mjs';

export {
  AGENT_DELETED_MARKER,
  DEFAULT_WORKFLOW_ID,
  FIXED_AGENT_SLOTS,
  clearAgentDefinitionCache,
  normalizeAgentId,
  normalizeWorkflowId,
} from './workflow-ids.mjs';

export const WORKFLOW_ROUTE_SLOTS = ['lead', 'agent', 'memory'];

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

export function workflowPresetId(slot) {
  return `workflow-${slot}`;
}

function workflowPresetName(slot) {
  return `WORKFLOW ${String(slot || '').toUpperCase()}`;
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
  const packs = createWorkflowPacks({ rootDir, dataDir, readMarkdownDocument });
  const agents = createWorkflowAgents({ rootDir, dataDir, readMarkdownDocument, normalizeAgentPermissionOrNone });
  return { ...packs, ...agents, ...createWorkflowContext({ packs, agents }) };
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
