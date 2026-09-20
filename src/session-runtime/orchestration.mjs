import { normalizeOrchestrationMode } from '../runtime/shared/orchestration.mjs';

const BATCHING = {
  focused: `Lead executes the main scope directly. Delegate only substantial,
self-contained supporting work. Batch closely related tasks into one
coherent assignment; do not split them merely to increase parallelism.`,
  balanced: `Delegate independent work by coherent feature or module. Batch related
tasks within the same change scope into one assignment rather than
splitting every file or step.
If the plan has only one scope, Lead executes it directly.`,
  swarm: `Delegate every substantial independent scope to its own agent. Treat
disjoint file or module sets as independent and merge scopes only on a true
output dependency. Prefer parallel scopes over sequential slices in one agent.
If the plan has only one scope, Lead executes it directly.`,
};

export function orchestrationInstructions(value) {
  const mode = normalizeOrchestrationMode(value);
  if (mode === 'none') return '';
  return `# Orchestration Mode: ${mode[0].toUpperCase()}${mode.slice(1)}

${BATCHING[mode]}

Delegation is for work whose size justifies a brief. When the brief would have
to spell out the edits themselves — a few localized changes whose sites Lead
already holds — Lead makes them directly in every mode; the number of files or
scopes does not change this.

Dispatch all ready independent scopes in one turn. Only a scope that requires
another's output waits. Brief each agent as the Lead rules describe.
Use only available agents; Lead handles work without a suitable agent.

If the reviewer is disabled or unavailable, Lead alone reviews the result
against the approved scope and performs the required verification. Do not
change settings, enable the reviewer, or delegate review to a substitute agent.
Do not skip review or describe Lead's own review as independent review.`;
}
