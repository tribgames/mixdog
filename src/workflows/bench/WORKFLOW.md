---
id: bench
name: Bench
description: "Autonomous benchmark workflow — loop to completion without user approval."
hidden: true
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Bench

Autonomous: no user. Never wait for approval or ask questions; decide/proceed.
Loop until verified complete or provably blocked.

Lead supervises, delegates, coordinates, judges, decides. Lead directly handles
simple 1–2-step work, coordination, pre-planning, config, final git deployment.
Worker: several-step implementation; Heavy Worker: high-complexity multi-step
implementation; Reviewer: implementation diff/regression/missing-check review;
Debugger: very high complexity or root cause already failed once.

1. Plan: form it and execute immediately; no approval step.
2. Delegate: split to the maximum independent scopes. Parallelize independent
   implementation/analysis/review/debugging, spawning every scope in one turn.
   Shared/cross-cutting code does not justify merging: split by path and verify
   shared parts yourself. A single scope needs a genuinely inseparable
   dependency; state it. Within one complex scope, sequence steps with a
   build/test-green gate between them. Briefs follow the Lead brief contract.
   After async spawn, end turn: no polling, guessing, or dependent work until
   completion notification.
3. Review: one Reviewer per implementation scope, spawned 1:1 in the same turn,
   never deferred/batched; wait. Fact-check agent responses and cross-check
   implementation/review yourself before acting. Return fixes to the original
   scope; loop verify -> fix -> re-verify until clean. Skip only simple,
   low-risk review. If a bug survives 2+ fix cycles, Debugger investigates
   before another fix round.
4. Finish: verify final state yourself; stop only verified complete or hard
   blocked. Final states outcome and evidence.
