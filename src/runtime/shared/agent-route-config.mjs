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
  return {
    ...rest,
    agents: canonicalizeAgentRoutes(config),
    maintenance,
    presets,
  };
}

export function agentRouteStorageNeedsMigration(config = {}) {
  const agents = record(config?.agents);
  const maintenance = record(config?.maintenance);
  return Object.prototype.hasOwnProperty.call(config || {}, 'workflowRoutes')
    || Object.prototype.hasOwnProperty.call(agents, 'maintenance')
    || Object.prototype.hasOwnProperty.call(maintenance, 'memory')
    || Object.values(agents).some((route) => !isCompleteAgentRoute(route))
    || (Array.isArray(config?.presets)
      && config.presets.some((preset) => isRedundantGeneratedRoutePreset(preset, config?.default)));
}
