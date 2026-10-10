// Orchestration is independent of workflow instructions and agent definitions.
export const ORCHESTRATION_MODES = Object.freeze(['none', 'focused', 'balanced', 'swarm']);

export const DEFAULT_ORCHESTRATION_MODE = 'balanced';

export function normalizeOrchestrationMode(value, fallback = 'none') {
  return ORCHESTRATION_MODES.includes(value) ? value : fallback;
}

// Before the setting existed, Solo/Headless disabled delegation; Cowork (the
// old `default` pack) and custom workflows enabled it. Solo was the shipped
// default workflow then, so only a non-Solo choice is an explicit user choice.
// Used for sessions recorded without a mode and by the one-time file
// separation; the live config never infers a mode from the workflow.
export function legacyWorkflowOrchestrationMode(active) {
  return active && active !== 'solo' && active !== 'headless' ? 'swarm' : 'none';
}

export function configuredOrchestrationMode(config) {
  if (Object.hasOwn(config || {}, 'orchestrationMode')) {
    return normalizeOrchestrationMode(config.orchestrationMode, DEFAULT_ORCHESTRATION_MODE);
  }
  return DEFAULT_ORCHESTRATION_MODE;
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
  if (workflow?.delegatesAgents === false || (workflow?.agentsConfigured === true && workflow?.agents?.length === 0))
    return 'none';
  if (workflow?.delegatesAgents === true) return 'swarm';
  return workflow ? legacyWorkflowOrchestrationMode(workflow.id) : 'swarm';
}
