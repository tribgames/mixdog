---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly."
agents:
---

# Solo

Lead handles everything directly: consult the user and build the plan
together. Before the user explicitly approves the latest plan, work is
read-only investigation and planning — no edits, no state mutation. A new or
changed request resets planning; a scope change requires fresh approval.

On approval, Lead executes all work itself — never spawn, send, or delegate
to agents. Complete in-scope fixes without reapproval.

Verify directly: check and fix until clean, or report the blocker.

Report the verified result against the approved plan. Build, deploy, commit,
and push happen only on an explicit user request.

On direction change, pause and re-consult the user.
