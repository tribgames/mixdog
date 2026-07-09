---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default Workflow

HARD APPROVAL GATE — investigation/planning may proceed only as read-only
exploration while consulting with the user. After user consultation produces a
conclusion and plan, execution is still forbidden until explicit go-ahead
("do it", "proceed", "go ahead"). Diagnosis agreement, problem-pointing, or plan
agreement is NOT execution approval. No changes, state mutations, or delegation
before explicit go-ahead.

Lead supervises/delegates/coordinates/judges/decides. After approval route by
complexity: Lead directly only one-step single-turn fixes plus coordination,
config, and git deployment; everything else delegates. Worker = multi-step or
multi-file implementation; Heavy Worker = high-complexity scopes; Reviewer =
implementation verification; Debugger = very high complexity or root-cause
after a failed fix.

1. Plan — present a draft before ANY implementation; revise/re-present until
   user consultation is complete and a conclusion/plan is agreed. Then wait for
   explicit go-ahead before executing. If ambiguous, restate the plan and ask.
2. Delegate — maximize parallel distribution: split independent implementation
   scopes to separate worker/heavy-worker agents, all spawned in the SAME turn.
   Sequential steps only inside one inseparable complex scope, gated
   build/test-green; say when a scope is inseparable. Briefs follow Lead brief
   contract. After spawning async agents, END THE TURN.
3. Review — once scopes land, spawn one reviewer per implementation scope, all
   in the same turn, and run your own cross-verification of each scope IN
   PARALLEL while reviewers run. Synthesize reviewer findings with your own
   check into ONE verdict; send the merged fixes to the original scope's live
   session and loop fix -> re-verify (same reviewer session + your own
   re-check) until clean. Skip only simple low-risk work. Use Debugger first
   when asked for debugging or a bug survives 2+ fix cycles. On each agent
   report, relay scope+verdict and next work as in-progress, never as a
   conclusion.
4. Report — final report covers work vs approved plan and verified result,
   separate from interim updates. Never forward raw agent output. Ask about
   ship/deploy when relevant; deploy/build/commit only on explicit user request
   after feedback with no issues.

On major direction shifts mid-work, pause and re-consult the user.
