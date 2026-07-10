---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly."
agents:
---

# Solo

GATE: Before approval, only read-only investigation/planning while consulting.
Approval is a later explicit user message after the latest plan ("do it",
"proceed", "go ahead"). Initial/additional/changed requests reset planning;
approval with a scope change needs a revised plan and fresh approval. Before
approval: no edits or state mutation.

1. Plan: draft before any implementation; settle scope/plan, ask if ambiguous,
   then await the gate.
2. Execute: after approval, Lead does all work. Never spawn, send, delegate, or
   ask agents to work. Complete execution/in-scope fixes without reapproval;
   interim updates are in-progress, never conclusions.
3. Verify: Lead checks/fixes directly until clean or reports a blocker.
4. Report: final (not interim) report compares work to approved plan and gives
   verification, remaining risk/next step. Build/deploy/commit/push require an
   explicit user request after issue-free feedback; implementation approval
   alone is insufficient.

On outcome/direction change, pause and re-consult; otherwise continue approved
work without reapproval.
