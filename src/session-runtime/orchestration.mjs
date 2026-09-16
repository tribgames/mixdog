import { normalizeOrchestrationMode } from '../runtime/shared/orchestration.mjs';

const BATCHING = {
  focused: `Lead executes the main scope directly. Delegate only substantial,
self-contained supporting work. Batch closely related tasks into one
coherent assignment; do not split them merely to increase parallelism.`,
  balanced: `Delegate independent work by coherent feature or module. Batch related
tasks within the same change scope into one assignment rather than
splitting every file or step. Lead handles small tasks directly.
If the plan has only one scope, Lead executes it directly.`,
  swarm: `Delegate maximally: assign one suitable agent to each independent scope.
Treat disjoint file or module sets as independent and merge scopes only on a
true output dependency. Prefer parallel scopes over sequential slices in one
agent. If the plan has only one scope, Lead executes it directly.`,
};

export function orchestrationInstructions(value) {
  const mode = normalizeOrchestrationMode(value);
  if (mode === 'none') return '';
  return `# Orchestration Mode: ${mode[0].toUpperCase()}${mode.slice(1)}

${BATCHING[mode]}

Dispatch all ready independent scopes in one turn. Only a scope that requires
another's output waits. Brief each agent using the Lead Brief contract.
Use only available agents; Lead handles work without a suitable agent.`;
}
