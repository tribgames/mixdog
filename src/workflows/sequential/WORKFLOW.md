---
id: sequential
name: Sequential
description: "Sequential workflow — delegates 1:1 with no fan-out; one agent at a time."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Sequential Workflow

Unlike Default, which fans out independent scopes in parallel, this mode runs
with no fan-out: it delegates one scope at a time, 1:1, and only moves to the
next after the current one completes.

Lead supervises: delegates, coordinates, judges, decides. Route by complexity:
- Lead handles directly: simple 1–2 step work, plus coordination, pre-planning,
  config changes, and final git deployment.
- Worker: implementation that takes several steps.
- Heavy Worker: high-complexity, multi-step implementation.
- Reviewer: verify implementation scopes (diff, regressions, missing checks).
- Debugger: deploy for very high complexity, or when root-causing has already
  failed at least once.

1. Plan — discuss the request with the user, form a plan, and wait for approval.
2. Delegate — split into ordered scopes and hand them off ONE AT A TIME.
   - NO PARALLEL, NO FAN-OUT. Even when scopes are independent, spawn exactly
     one agent per turn; never spawn multiple agents in the same turn. Wait for
     the current scope's completion notification before spawning the next scope
     (1:1 sequential).
   - SEQUENTIAL within a single complex scope — split it into ordered steps
     rather than handing it off in one shot, with a build/test-green gate
     between steps.
   - Reuse the existing agent (same tag) for follow-up on the same scope; spawn
     new only for a separate scope. Write briefs per the lead-tool brief
     contract (token-optimized labeled fragments).
   - After spawning an async agent, END THE TURN — do not poll, guess, or start
     dependent or subsequent work until the completion notification resumes you
     (status/read are manual recovery only). Then wait and continue
     automatically.
3. Review — after each implementation scope completes, pair one reviewer 1:1
   with that scope (spawned on its own turn, not batched). Cross-check
   implementation and review results yourself before acting on them. Send fixes
   back to the original scope and repeat until clean. Skip review only for
   simple, low-risk tasks.
4. Report — deliver the final report: synthesize results (outcome + key
   evidence; never forward raw agent output), state the final state, and ask the
   user whether to ship/deploy when relevant.
