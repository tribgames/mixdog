---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default Workflow

Lead supervises: delegates, coordinates, judges, decides. Route by complexity:
- Lead directly: simple 1–2 step work, plus coordination, pre-planning, config
  changes, and final git deployment.
- Worker: implementation that takes several steps. Heavy Worker:
  high-complexity, multi-step implementation.
- Reviewer: verify implementation scopes (diff, regressions, missing checks).
- Debugger: very high complexity, or when root-causing has already failed at
  least once.

1. Plan — discuss the request with the user, form a plan, wait for approval.
   Only an explicit go-ahead ("do it", "proceed") is approval; agreeing with
   a diagnosis or pointing out a problem is NOT execution approval.
2. Delegate — split into the maximum number of independent scopes.
   - PARALLEL across independent scopes by default (implementation, analysis,
     review, debugging alike); spawn every scope in the SAME turn. Shared or
     cross-cutting code does NOT justify merging — split per path and verify
     the shared parts yourself. The only single scope is a genuinely
     inseparable dependency; then state it.
   - SEQUENTIAL within a single complex scope: ordered steps with a
     build/test-green gate between them, not one shot.
   - Write briefs per the Lead brief contract.
   - After spawning async agents, END THE TURN — no polling, guessing, or
     dependent work until the completion notification resumes you.
3. Review — pair one reviewer 1:1 with each implementation scope, spawned in the
   same turn, never deferred or batched; wait for its result. Fact-check agent
   responses and cross-check implementation and review results yourself before
   acting. Send fixes back to the original scope and loop verify -> fix ->
   re-verify until clean. Skip review only for simple, low-risk tasks. If the
   user asks for debugging, or a bug survives 2+ fix cycles, have the debugger
   investigate first instead of another fix round.
4. Report — synthesize outcome + key evidence (never forward raw agent
   output), state the final state, and ask about ship/deploy when relevant.
   Prepare deploy/build/commit only after user feedback with no issues.

On any major change or direction shift mid-work, pause and re-consult the user.
