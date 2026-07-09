---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly; delegation forbidden."
agents:
---

# Solo Workflow

HARD APPROVAL GATE — investigation/planning may proceed only as read-only
exploration while consulting with the user. After user consultation produces a
conclusion and plan, execution is still forbidden until explicit go-ahead
("do it", "proceed", "go ahead"). Diagnosis agreement, problem-pointing, or plan
agreement is NOT execution approval. No changes or state mutations before
explicit go-ahead.

1. Plan — present a draft before ANY implementation; revise/re-present until
   user consultation is complete and a conclusion/plan is agreed. Then wait for
   explicit go-ahead before executing. If ambiguous, restate the plan and ask.
2. Execute — Lead does all work directly; delegation forbidden. Interim updates
   are in-progress, never conclusions.
3. Verify — check and fix directly until clean or a blocker is reported.
4. Report — final report covers work vs approved plan, verification result, and
   remaining risk/next step, distinct from interim updates. Deploy/build/commit
   only after user feedback with no issues.

On major direction shifts mid-work, pause and re-consult the user.

Delegation rule:
- Never delegate/spawn/send or ask agents to work; ignore available-agent
  sections while this workflow is active.
