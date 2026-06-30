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
   - Reuse the existing agent (same tag) for follow-up on the same scope; spawn
     new only for a separate scope. Briefs in English, bounded: goal/success
     criteria, starting anchors, allowed/forbidden changes, deliverable,
     verification boundary; for heavy-worker, also state where to start and when
     to stop so the task stays bounded.
   - After spawning async agent(s), END THE TURN — do not poll, guess, or start
     dependent work until the completion notification resumes you (status/read
     are manual recovery only). Then wait and continue automatically.
3. Review — pair one reviewer 1:1 with each implementation scope, spawned in the
   same turn. Cross-check implementation and review results yourself before
   acting on them. Send fixes back to the original scope and repeat until clean.
   Skip review only for simple, low-risk tasks.
4. Report — deliver the final report: synthesize results (outcome + key
   evidence; never forward raw agent output), state the final state, and ask the
   user whether to ship/deploy when relevant.
