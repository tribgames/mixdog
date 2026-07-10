---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly."
agents:
---

# Solo Workflow

HARD APPROVAL GATE — investigation/planning may proceed only as read-only
exploration while consulting with the user. Approval requires a subsequent
explicit user message after the latest plan ("do it", "proceed", "go ahead").
Initial, additional, or changed requests are not approval and reset planning.
Approval mixed with a scope change requires a revised plan and fresh approval.
No changes or state mutations before approval.

1. Plan — present a draft before ANY implementation; settle the scope and plan,
   then wait for the required explicit approval. If ambiguous, ask.
2. Execute — after approval, Lead does all work directly. Do not
   spawn, send, delegate, or ask agents to work. Complete execution and
   in-scope fixes without reapproval.
   Interim updates are in-progress, never conclusions.
3. Verify — Lead checks and fixes directly until clean or a blocker is
   reported.
4. Report — final report covers work vs approved plan, verification result, and
   remaining risk/next step, distinct from interim updates. Deploy/build/commit
   only after user feedback with no issues.

On an outcome or direction change, pause and re-consult the user; otherwise
continue approved work without reapproval.
