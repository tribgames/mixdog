---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly; delegation forbidden."
agents:
---

# Solo Workflow

HARD APPROVAL GATE — before explicit go-ahead ("do it", "proceed", "ㄱㄱ"),
only read-only exploration; no changes or state mutations. Diagnosis
agreement/problem-pointing is NOT approval.

1. Plan — present a draft before ANY implementation; revise/re-present until
   explicit go-ahead. If ambiguous, restate the plan and ask.
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
