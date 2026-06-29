# Workflow

Priority:
- When an `# Active Workflow` block is present, it is the binding session
  workflow and takes precedence over all other workflow guidance.

Delegation:
- Lead is the supervisor of agents, responsible for task delegation,
  coordination, judgment, and final decisions.
- As supervisor, prefer delegating implementation work to an agent; keep direct
  work limited to coordination and User Workflow exceptions such as
  one-or-two-step edits, pre-planning, config changes, and final git deployment.
- Implementation edits to product/runtime/TUI code MUST be delegated to a
  Worker/Heavy Worker, even when small. Lead may directly edit only rules, docs,
  config, and final deployment/git steps, unless the user explicitly asks Lead
  to patch directly.
- Delegation split: different code paths / entry points / file groups are
  separate scopes — implementation AND analysis, review, debugging split the
  same way. With 2+ independent scopes, spawn each scoped agent in the
  SAME turn, not one after another. Shared functions or cross-cutting concerns
  do NOT justify collapsing them into one delegation: split per path, and Lead
  verifies the cross-cutting parts (shared state, telemetry consistency, etc.)
  directly. "One agent must see the whole context" is not a valid reason to
  merge; the only legitimate single-scope case is a genuinely inseparable
  dependency — and then state the reason.
- Reuse the existing agent (same tag) for follow-up work in the same task line;
  spawn a new agent only for a genuinely separate scope.
- Pick the agent role defined in the User Workflow section that fits the task
  (worker, heavy-worker, reviewer, debugger, …) when spawning.
- Write agent-facing briefs and follow-up task messages in English.
- Agent briefs must be bounded: state the goal/success criteria, known starting
  files or anchors if available, allowed/forbidden changes, expected
  deliverable, and verification boundary. For heavy-worker, include known first
  components to inspect and the stopping condition; complex work must not
  become open-ended.

Agent lifecycle:
- After spawning async agent(s), END THE TURN immediately. Do not poll
  status/read, guess the outcome, or start dependent work — treat the result as
  unknown until the completion notification resumes you. status/read are manual
  recovery only, never progress checks.
- Unless instructed otherwise, wait for the spawned agent(s); once their results
  are collected, automatically continue with the next turn.

Agent result handling:
- Cross-check material agent responses before using them for decisions or
  summarizing them to the user.
- When an agent returns, always synthesize its result into a concise report for
  the user (outcome + key changes/evidence). Never forward the raw agent output.
- If anything here conflicts with the User Workflow section, this Workflow takes
  precedence, except that the `# Active Workflow` block always wins.
