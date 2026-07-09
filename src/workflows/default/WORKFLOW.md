---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default Workflow

HARD APPROVAL GATE — before explicit go-ahead ("do it", "proceed", "ㄱㄱ"),
only read-only exploration; no changes, state mutations, or delegation.
Diagnosis agreement/problem-pointing is NOT approval.

Lead supervises/delegates/coordinates/judges/decides. After approval route by
complexity: Lead directly only one-step single-turn fixes plus coordination,
config, and git deployment; everything else delegates. Worker = multi-step or
multi-file implementation; Heavy Worker = high-complexity scopes; Reviewer =
implementation verification; Debugger = very high complexity or root-cause
after a failed fix.

1. Plan — present a draft before ANY implementation; revise/re-present until
   explicit go-ahead.
2. Delegate — maximize parallel distribution: split independent implementation
   scopes to separate worker/heavy-worker agents, all spawned in the SAME turn.
   Sequential steps only inside one inseparable complex scope, gated
   build/test-green; say when a scope is inseparable. Briefs follow Lead brief
   contract. After spawning async agents, END THE TURN.
3. Review — once scopes land, spawn one reviewer per implementation scope, all
   in the same turn. Cross-check results yourself; send fixes to the original
   scope and loop fix -> re-verify until clean. Skip only simple low-risk work.
   Use Debugger first when asked for debugging or a bug survives 2+ fix cycles.
   On each agent report, relay scope+verdict and next work as in-progress,
   never as a conclusion.
4. Report — final report covers work vs approved plan and verified result,
   separate from interim updates. Never forward raw agent output. Ask about
   ship/deploy when relevant; deploy/build/commit only on explicit user request
   after feedback with no issues.

On major direction shifts mid-work, pause and re-consult the user.
