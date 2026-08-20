const REDUNDANT_WORKFLOW_PRESET_IDS = new Set([
  'workflow-agent',
  'workflow-memory',
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function isCompleteAgentRoute(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !!String(value.provider || '').trim()
    && !!String(value.model || '').trim();
}

function agentIdKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// "Off" is a first-class agent state, not an absent route: config.agents[<id>]
// only survives canonicalization with a complete provider+model pair, so a
// disabled agent keeps its stored model and is listed here instead. Turning the
// agent back on therefore restores the model the user last picked.
export function disabledAgentIds(config) {
  const raw = config?.disabledAgents;
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  for (const entry of raw) {
    const id = agentIdKey(entry);
    if (id) ids.add(id);
  }
  return [...ids].sort();
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

export function canonicalizeAgentRoutes(config = {}) {
  const agents = Object.fromEntries(
    Object.entries(record(config.agents)).filter(([, route]) => isCompleteAgentRoute(route)),
  );
  delete agents.maintenance;
  return agents;
}

export function isRedundantGeneratedRoutePreset(preset, defaultPreset = null) {
  const id = String(preset?.id || '').trim();
  if (!id || id === String(defaultPreset || '').trim()) return false;
  return REDUNDANT_WORKFLOW_PRESET_IDS.has(id) || id.startsWith('workflow-agent-');
}

export function canonicalizeAgentRouteStorage(config = {}) {
  const {
    workflowRoutes: _legacyWorkflowRoutes,
    ...rest
  } = config || {};
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
  return Object.prototype.hasOwnProperty.call(config || {}, 'workflowRoutes')
    || (Object.prototype.hasOwnProperty.call(config || {}, 'disabledAgents')
      && JSON.stringify(config.disabledAgents) !== JSON.stringify(disabled.length ? disabled : undefined))
    || Object.prototype.hasOwnProperty.call(agents, 'maintenance')
    || Object.prototype.hasOwnProperty.call(maintenance, 'memory')
    || Object.values(agents).some((route) => !isCompleteAgentRoute(route))
    || (Array.isArray(config?.presets)
      && config.presets.some((preset) => isRedundantGeneratedRoutePreset(preset, config?.default)));
}
