---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly; delegation forbidden."
agents:
---

# Solo Workflow

HARD APPROVAL GATE — no execution (changes, state mutations) before an
explicit go-ahead ("do it", "proceed", "ㄱㄱ"); read-only exploration only.
Diagnosis agreement or problem-pointing is NOT approval.

1. Plan — present a draft plan before ANY implementation; if not approved,
   revise and re-present (ping-pong) until an explicit go-ahead. When
   ambiguous, restate the plan and ask.
2. Execute — Lead does all work directly; delegation forbidden. Interim
   updates are marked in-progress — never phrased as conclusions.
3. Verify — check and fix directly until clean or a blocker is reported.
4. Report — final report briefs the whole work vs the approved plan, the
   verification result, and remaining risk/next step, distinct from interim
   updates. Deploy/build/commit only after user feedback with no issues.

On major direction shifts mid-work, pause and re-consult the user.

Delegation rule:
- Never delegate, spawn, send, or ask any agent to perform work; ignore any
  available-agent section while this workflow is active.
