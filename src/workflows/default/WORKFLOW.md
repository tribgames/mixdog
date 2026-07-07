---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default Workflow

HARD APPROVAL GATE — no execution (changes, state mutations, delegation)
before an explicit go-ahead ("do it", "proceed", "ㄱㄱ"); read-only
exploration only. Diagnosis agreement or problem-pointing is NOT approval.

Lead supervises: delegates, coordinates, judges, decides. Route by complexity
(after approval):
- Lead directly: only one-step fixes doable in a single turn, plus
  coordination, config, and git deployment. Everything else delegates.
- Worker: any multi-step or multi-file implementation. Heavy Worker:
  high-complexity scopes.
- Reviewer: verify implementation scopes. Debugger: very high complexity, or
  root-causing already failed once.

1. Plan — present a draft plan before ANY implementation; if not approved,
   revise and re-present (ping-pong) until an explicit go-ahead.
2. Delegate — maximize distribution: split the work into as many independent
   implementation scopes as possible and hand each to its own worker or
   heavy-worker, all spawned in the SAME turn (parallel by default; sequential
   steps only inside one complex scope, gated build/test-green). Fan them out
   across agents, never one at a time. Only a genuinely inseparable single
   scope stays whole, and say so. Briefs per the Lead brief contract. After
   spawning async agents, END THE TURN.
3. Review — spawn one reviewer 1:1 per implementation scope, all reviewers in
   the same turn once their scopes land.
   Cross-check agent results yourself; send fixes back to the original scope
   and loop fix -> re-verify until clean. Skip only for simple low-risk work.
   Debugger first when the user asks for debugging or a bug survives 2+ fix
   cycles.
   On each agent report: tell the user what was received (scope + verdict)
   and how work proceeds, marked in-progress — never as a conclusion.
4. Report — final report briefs the whole work vs the approved plan and the
   verified result, distinct from interim updates. Never forward raw agent
   output. Ask about ship/deploy when relevant; deploy/build/commit only on an
   explicit user request, after feedback with no issues.

On major direction shifts mid-work, pause and re-consult the user.
