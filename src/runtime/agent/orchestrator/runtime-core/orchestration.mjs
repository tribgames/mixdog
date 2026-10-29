import { normalizeOrchestrationMode } from '../../../shared/orchestration.mjs';

const BATCHING = {
  focused: `Lead executes the main scope directly. Delegate only substantial,
self-contained supporting work, one agent per role; batch related tasks
rather than splitting them for parallelism.`,
  balanced: `Delegate independent work by coherent feature or module, one agent per
scope; a scope is one verifiable deliverable. Batch related tasks within the
same change scope rather than splitting every file or step.`,
  swarm: `Delegate every independent scope to its own agent; a scope is one
verifiable deliverable, not a bundle of steps. Treat disjoint file or
module sets as independent and merge scopes only on a true output
dependency.`,
};

const SOLO = `# Orchestration Mode: Solo

Lead executes all work directly and never delegates on its own judgment.
Only when the user explicitly asks for delegation, load the deferred \`agent\`
tool and brief each agent as the Lead rules describe.`;

/** Agent mode's fixed delegation block, in place of the orchestration mode. */
export const AGENT_MODE_DELEGATION = `# Delegation

Handle conversation yourself. Delegate specialised work to sub-agents. Hand
substantial coding to a new agent task session (\`session create\`) with
a self-contained brief: start it when already requested, otherwise suggest it. Then relay the
result in your own words. Promise a follow-up only when the session result allows it.`;

/** An agent-mode Lead's contact catalog intro: the user's other bots. */
export const MIXY_CONTACTS_INTRO = `The user's other bots. Hand one a request with \`session send\` to its chat and a
self-contained brief.`;

export function orchestrationInstructions(value) {
  const mode = normalizeOrchestrationMode(value);
  if (mode === 'none') return SOLO;
  // Focused already says Lead executes the main scope directly.
  const oneScope =
    mode === 'focused' ? '' : '\nIf the plan has only one implementation scope, Lead executes it directly.';
  return `# Orchestration Mode: ${mode[0].toUpperCase()}${mode.slice(1)}

${BATCHING[mode]}

The mode sets how work splits; an agent's description sets its role and when
it runs. Splitting applies to every role alike — implementation, review,
investigation, writing — by file, module, commit range or risk area.${oneScope}

Delegation is for work whose size justifies a brief. When the brief would have
to spell out the edits themselves — a few localized changes whose sites Lead
already holds — Lead makes them directly in every mode; the number of files or
scopes does not change this.

Dispatch all ready independent scopes in one turn. Only a scope that requires
another's output waits. At most two building or testing scopes run at
once.
A new independent need goes to a new agent. When scopes touch the same file, name one owner for
that file in each brief.
Use only available agents; when none fits a role, Lead does that work itself
and never changes settings to enable one.`;
}
