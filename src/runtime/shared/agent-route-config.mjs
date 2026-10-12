import { hasOwn, isPlainObject } from './object.mjs';

const REDUNDANT_WORKFLOW_PRESET_IDS = new Set(['workflow-agent', 'workflow-memory']);

export const DEFAULT_DISABLED_AGENT_IDS = Object.freeze([
  'worker',
  'heavy-worker',
  'reviewer',
  'advisor',
  'security',
  'front-worker',
  'writer',
]);

// The Maintainer also starts off: background upkeep spends model calls, so it
// runs only once the user turns it on and picks its model.
export const DEFAULT_DISABLED_AGENT_ROSTER = Object.freeze([...DEFAULT_DISABLED_AGENT_IDS, 'maintainer']);

function record(value) {
  return isPlainObject(value) ? value : {};
}

function isCompleteAgentRoute(value) {
  return isPlainObject(value) && !!String(value.provider || '').trim() && !!String(value.model || '').trim();
}

function agentIdKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

// "Off" is a first-class agent state, not an absent route: config.agents[<id>]
// only survives canonicalization with a complete provider+model pair, so a
// disabled agent keeps its stored model and is listed here instead. Turning the
// agent back on therefore restores the model the user last picked.
function agentIdList(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  for (const entry of raw) {
    const id = agentIdKey(entry);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export function disabledAgentIds(config) {
  return agentIdList(config?.disabledAgents);
}

// Stored shape is a user delta against DEFAULT_DISABLED_AGENT_ROSTER:
// `disabledAgents` lists ids the user turned off that are on by default and
// `enabledAgents` lists default-off ids the user turned on. The in-memory
// config carries the effective list in `disabledAgents`.
export function effectiveDisabledAgents(stored) {
  const enabled = new Set(agentIdList(stored?.enabledAgents));
  return agentIdList([...DEFAULT_DISABLED_AGENT_ROSTER, ...agentIdList(stored?.disabledAgents)]).filter(
    (id) => !enabled.has(id)
  );
}

export function disabledAgentDelta(effective, defaults = DEFAULT_DISABLED_AGENT_ROSTER) {
  const wanted = new Set(agentIdList(effective));
  const base = new Set(defaults);
  const disabledAgents = [...wanted].filter((id) => !base.has(id)).sort();
  const enabledAgents = [...base].filter((id) => !wanted.has(id)).sort();
  return {
    ...(disabledAgents.length ? { disabledAgents } : {}),
    ...(enabledAgents.length ? { enabledAgents } : {}),
  };
}

function withDisabledKeys(config, delta) {
  const next = { ...(config || {}) };
  delete next.disabledAgents;
  delete next.enabledAgents;
  return { ...next, ...delta };
}

/** Stored (delta) form of an in-memory config. */
export function withStoredDisabledAgents(config) {
  return withDisabledKeys(config, disabledAgentDelta(config?.disabledAgents));
}

/** In-memory (effective) form of a stored config. */
export function withEffectiveDisabledAgents(config) {
  const effective = effectiveDisabledAgents(config);
  return withDisabledKeys(config, effective.length ? { disabledAgents: effective } : {});
}

export function isAgentDisabled(config, agentId) {
  const id = agentIdKey(agentId);
  if (!id) return false;
  return disabledAgentIds(config).includes(id);
}

export function withAgentDisabled(config, agentId, disabled) {
  const next = { ...(config || {}) };
  const id = agentIdKey(agentId);
  if (!id) return next;
  const ids = new Set(disabledAgentIds(config));
  if (disabled) ids.add(id);
  else ids.delete(id);
  const list = [...ids].sort();
  if (list.length) next.disabledAgents = list;
  else delete next.disabledAgents;
  return next;
}

// Canonical route location is config.agents[<id>] only. No migration: routes
// left under retired slots (agents.maintenance, workflowRoutes.*,
// maintenance.memory, generated workflow-* presets) are scrubbed by
// canonicalizeAgentRouteStorage, never folded in.
export function configuredAgentRouteCandidates(config, agentId) {
  const id = String(agentId || '').trim();
  if (!id) return [];
  const route = record(config?.agents)[id];
  return route ? [route] : [];
}

function canonicalizeAgentRoutes(config = {}) {
  const agents = Object.fromEntries(
    Object.entries(record(config.agents)).filter(([, route]) => isCompleteAgentRoute(route))
  );
  delete agents.maintenance;
  return agents;
}

function isRedundantGeneratedRoutePreset(preset, defaultPreset = null) {
  const id = String(preset?.id || '').trim();
  if (!id || id === String(defaultPreset || '').trim()) return false;
  return REDUNDANT_WORKFLOW_PRESET_IDS.has(id) || id.startsWith('workflow-agent-');
}

export function canonicalizeAgentRouteStorage(config = {}) {
  const { workflowRoutes: _legacyWorkflowRoutes, ...rest } = config || {};
  const maintenance = { ...record(config?.maintenance) };
  delete maintenance.memory;
  const presets = Array.isArray(config?.presets)
    ? config.presets.filter((preset) => !isRedundantGeneratedRoutePreset(preset, config?.default))
    : [];
  const next = {
    ...rest,
    agents: canonicalizeAgentRoutes(config),
    maintenance,
    presets,
  };
  const disabled = disabledAgentIds(config);
  if (disabled.length) next.disabledAgents = disabled;
  else delete next.disabledAgents;
  return next;
}

export function agentRouteStorageNeedsMigration(config = {}) {
  const agents = record(config?.agents);
  const maintenance = record(config?.maintenance);
  const disabled = disabledAgentIds(config);
  return (
    hasOwn(config, 'workflowRoutes') ||
    (hasOwn(config, 'disabledAgents') &&
      JSON.stringify(config.disabledAgents) !== JSON.stringify(disabled.length ? disabled : undefined)) ||
    hasOwn(agents, 'maintenance') ||
    hasOwn(maintenance, 'memory') ||
    Object.values(agents).some((route) => !isCompleteAgentRoute(route)) ||
    (Array.isArray(config?.presets) &&
      config.presets.some((preset) => isRedundantGeneratedRoutePreset(preset, config?.default)))
  );
}
