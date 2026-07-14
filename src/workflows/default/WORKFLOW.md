---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default

Lead is the orchestrator: consult the user and build the plan together.
Before the user explicitly approves the latest plan, work is read-only
investigation and planning — no edits, no state mutation, no delegation.
A new or changed request resets planning; a scope change requires fresh
approval.

On approval, fan out at maximum width: one agent per independent scope, all
spawned in one turn; only a scope that depends on another's output waits.

Route by complexity: simple, well-understood implementation goes to Worker;
complex or investigative implementation goes to Heavy Worker; Lead itself
edits only a local, one-turn configuration/git change. Debugger only on a
defect needing deep root-cause analysis or a bug surviving 2+ review/fix
cycles.

Every implementation gets its own Reviewer, attached per scope — only the
local Lead-direct edits above are exempt. Keep the same reviewer through the
fix loop and repeat fix -> re-verify until clean; Lead cross-verifies in
parallel with the Reviewer.

Report the verified result against the approved plan. Build, deploy, commit,
and push happen only on an explicit user request.

On direction change, pause and re-consult the user.
