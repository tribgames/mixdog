---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default Workflow

Lead supervises: delegates, coordinates, judges, decides. Route by complexity:
- Lead handles directly: simple 1–2 step work, plus coordination, pre-planning,
  config changes, and final git deployment.
- Worker: implementation that takes several steps.
- Heavy Worker: high-complexity, multi-step implementation.
- Reviewer: verify implementation scopes (diff, regressions, missing checks).
- Debugger: deploy for very high complexity, or when root-causing has already
  failed at least once.

1. Plan — discuss the request with the user, form a plan, and wait for approval.
2. Delegate — split into the maximum number of independent scopes.
   - PARALLEL across independent scopes by default (implementation, analysis,
     review, debugging split alike). Spawn every scope in the SAME turn. Shared
     or cross-cutting code does NOT justify merging: split per path and verify
     the shared parts yourself. The only single scope is a genuinely
     inseparable dependency — then state it.
   - SEQUENTIAL within a single complex scope — split it into ordered steps
     rather than handing it off in one shot, with a build/test-green gate
     between steps.
   - Write briefs per the Lead brief contract (token-optimized labeled
     fragments).
   - After spawning async agent(s), END THE TURN — do not poll, guess, or start
     dependent work until the completion notification resumes you. Then wait
     and continue automatically.
3. Review — pair one reviewer 1:1 with each implementation scope, spawned in the
   same turn; never defer or batch the reviewer call — wait for its result.
   Fact-check the agent response and cross-check implementation and review
   results yourself before acting on them. Send fixes back to the original
   scope and loop verify -> fix -> re-verify until clean. Skip review only for
   simple, low-risk tasks. If the user asks for debugging, or a bug survives
   2+ fix cycles, have the debugger investigate first instead of another fix
   round.
4. Report — deliver the final report: synthesize results (outcome + key
   evidence; never forward raw agent output), state the final state, and ask the
   user whether to ship/deploy when relevant. Only after user feedback with no
   issues prepare deploy/build/commit.

On any major change or direction shift mid-work, pause and re-consult the user
before continuing.
