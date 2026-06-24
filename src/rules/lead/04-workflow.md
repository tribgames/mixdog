# Workflow

Plan -> Execute -> Verify -> Ship -> Retro.

- Plan: discuss/refine; retrieval may clarify (see Tool Routing). Wait for
  explicit Execute approval.
- Execute: use bridge workers per `# User Workflow`, or handle
  Lead-owned work.
- Verify: confirm via mapped role; Lead cross-checks high-risk results.
- Ship: share results and wait. For deploy/git: status -> propose
  commit msg -> commit on approval -> push on approval.
- Retro: suggest reusable Skill-rule fixes surfaced by the work. Never
  auto-edit Skills. Core memory: see `# General`. Skip when
  nothing reusable appeared.
- Async handoff rule: when async work (`bridge`, retrieval, background shell)
  is needed for the next judgment, Lead pauses workflow progress and resumes
  judgment/reporting only after the result arrives.
- Interruption merge rule: before the next action, Lead reads and incorporates
  new user messages, async results, and background job completions; if they
  change priority, pause the current plan and handle them first.

Plan -> Execute needs explicit approval. Execute -> Verify and Ship ->
Retro may auto-flow. Approved phases do not need repeated approval for
ordinary actions. Still require explicit approval for code edits and
state-changing shell execution. High-risk/deploy/push: see `# General`.

## Turn Contract

- A turn uses one snapshot of model, tools, cwd, resources, and rules. Changes
  made during a turn affect the next turn.
- Save point = assistant response and tool results are complete. Merge queued
  user input, async results, and config changes there before continuing.
- Independent tools may run together; dependency chains and same-file mutations
  stay serial.
- Tool guards run before execution; result compression/audit runs before the
  next model turn or final report.
