const LEGACY_AGENT_ROUTE_SLOTS = Object.freeze({
  explore: Object.freeze({ workflow: 'explorer', maintenance: 'explore' }),
  maintainer: Object.freeze({ alias: 'maintenance', workflow: 'memory', maintenance: 'memory' }),
  worker: Object.freeze({ workflow: 'agent' }),
});

const REDUNDANT_WORKFLOW_PRESET_IDS = new Set([
  'workflow-agent',
  'workflow-explorer',
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

function generatedPresetAgentId(preset) {
  const id = String(preset?.id || '').trim().toLowerCase();
  if (id === 'workflow-agent') return 'worker';
  if (id === 'workflow-explorer') return 'explore';
  if (id === 'workflow-memory') return 'maintainer';
  if (!id.startsWith('workflow-agent-')) return '';
  const suffix = id.slice('workflow-agent-'.length);
  if (suffix === 'explorer' || suffix === 'explore') return 'explore';
  if (suffix === 'maintenance' || suffix === 'memory' || suffix === 'maintainer') return 'maintainer';
  return suffix;
}

function routeFromGeneratedPreset(preset) {
  const provider = String(preset?.provider || '').trim();
  const model = String(preset?.model || '').trim();
  if (!provider || !model) return null;
  const route = { provider, model };
  const effort = String(preset?.effort || '').trim();
  if (effort) route.effort = effort;
  if (preset?.fast === true) route.fast = true;
  return route;
}

export function configuredAgentRouteCandidates(config, agentId) {
  const id = String(agentId || '').trim();
  if (!id) return [];
  const agents = record(config?.agents);
  const legacy = LEGACY_AGENT_ROUTE_SLOTS[id] || null;
  const candidates = [agents[id]];
  if (legacy?.alias) candidates.push(agents[legacy.alias]);
  if (legacy?.workflow) candidates.push(record(config?.workflowRoutes)[legacy.workflow]);
  if (legacy?.maintenance) candidates.push(record(config?.maintenance)[legacy.maintenance]);
  return candidates.filter(Boolean);
}

export function canonicalizeAgentRoutes(config = {}) {
  const sourceAgents = record(config.agents);
  const agents = Object.fromEntries(
    Object.entries(sourceAgents).filter(([, route]) => isCompleteAgentRoute(route)),
  );
  for (const id of Object.keys(LEGACY_AGENT_ROUTE_SLOTS)) {
    if (agents[id]) continue;
    const candidate = configuredAgentRouteCandidates({ ...config, agents: sourceAgents }, id)
      .find((route) => isCompleteAgentRoute(route));
    if (candidate) agents[id] = candidate;
  }
  delete agents.maintenance;
  // Older settings saves generated one preset per fixed/custom agent. Promote
  // a preset only when no higher-priority canonical/legacy route exists, then
  // the redundant preset can be removed without discarding user assignments.
  for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
    const id = generatedPresetAgentId(preset);
    if (!id || agents[id]) continue;
    const route = routeFromGeneratedPreset(preset);
    if (route) agents[id] = route;
  }
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
  delete maintenance.explore;
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
    || Object.prototype.hasOwnProperty.call(maintenance, 'explore')
    || Object.prototype.hasOwnProperty.call(maintenance, 'memory')
    || Object.values(agents).some((route) => !isCompleteAgentRoute(route))
    || (Array.isArray(config?.presets)
      && config.presets.some((preset) => isRedundantGeneratedRoutePreset(preset, config?.default)));
}
