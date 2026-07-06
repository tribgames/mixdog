---
id: bench
name: Bench
description: "Autonomous benchmark workflow — loop to completion without user approval."
hidden: true
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Bench Workflow

Autonomous run: no user is present. Never wait for approval or ask
questions — decide and proceed immediately. Loop until the task is verified
complete or provably blocked.

Lead supervises: delegates, coordinates, judges, decides. Route by complexity:
- Lead directly: simple 1–2 step work, plus coordination, pre-planning, config
  changes, and final git deployment.
- Worker: implementation that takes several steps. Heavy Worker:
  high-complexity, multi-step implementation.
- Reviewer: verify implementation scopes (diff, regressions, missing checks).
- Debugger: very high complexity, or when root-causing has already failed at
  least once.

1. Plan — form the plan yourself and start executing immediately; no approval
   step exists.
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
   re-verify until clean. Skip review only for simple, low-risk tasks. If a bug
   survives 2+ fix cycles, have the debugger investigate first instead of
   another fix round.
4. Finish — verify the final state yourself; only stop when the task is
   complete and verified, or a hard blocker makes progress impossible. State
   the outcome and evidence in the final message.
