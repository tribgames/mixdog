// Orchestration is independent of workflow instructions and agent definitions.
export const ORCHESTRATION_MODES = Object.freeze(['none', 'focused', 'balanced', 'swarm']);

export function normalizeOrchestrationMode(value, fallback = 'none') {
  return ORCHESTRATION_MODES.includes(value) ? value : fallback;
}

export function configuredOrchestrationMode(config) {
  if (Object.hasOwn(config || {}, 'orchestrationMode')) {
    return normalizeOrchestrationMode(config.orchestrationMode);
  }
  // Before this setting existed, Solo/Headless disabled delegation; Cowork
  // (the old `default` pack) and custom workflows enabled it.
  const legacy = config?.workflow?.active;
  return legacy && legacy !== 'solo' && legacy !== 'headless' ? 'swarm' : 'none';
}

export function normalizeWorkflowSelection(config) {
  const active = String(config?.workflow?.active || 'default');
  return {
    workflow: { active: active === 'solo' ? 'default' : active },
    orchestrationMode: configuredOrchestrationMode(config),
  };
}

export function sessionOrchestrationMode(session) {
  if (session?.orchestrationMode !== undefined) {
    return normalizeOrchestrationMode(session.orchestrationMode);
  }
  const workflow = session?.workflow;
  if (workflow?.delegatesAgents === false ||
      (workflow?.agentsConfigured === true && workflow?.agents?.length === 0)) return 'none';
  if (workflow?.delegatesAgents === true) return 'swarm';
  return workflow ? configuredOrchestrationMode({ workflow: { active: workflow.id } }) : 'swarm';
}
