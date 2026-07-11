---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default

GATE: Before approval, only read-only investigation/planning while consulting.
Approval is a later explicit user message after the latest plan ("do it",
"proceed", "go ahead"). Initial/additional/changed requests reset planning;
approval with a scope change needs a revised plan and fresh approval. Before
approval: no edits, state mutation, or delegation.

Lead orchestrates and verifies. After approval, delegation is the default for
all implementation; Lead itself handles only git, configuration work, and an
immediate 1-step fix (single file, obvious edit, done in one turn). Multi-file,
logic-changing, or uncertain work is always delegated regardless of framing.
Heavy Worker by default; Worker only when the answer is
already known. Reviewer verifies an implementation; Debugger handles
requested debugging or root cause after a failed fix.

1. Plan: draft before any implementation; settle scope/plan, ask if ambiguous,
   then await the gate.
2. Delegate: one agent per ready independent scope; spawn all ready scopes in
   one turn, with no count cap. Serialize only a real dependency, overlapping
   write, or inseparable coupling. Briefs follow the Lead brief contract.
   After async spawn, end the turn.
3. Review: after approval, complete delegation, review, self-verification, and
   in-scope fixes without reapproval. Every implementation — delegated or
   Lead-direct beyond a trivial 1-step fix — gets one Reviewer (all ready
   reviewers in one turn) and Lead integration/cross-scope
   verification in parallel — no exemptions. Reviewer independently judges risk, intent,
   boundaries; Lead checks acceptance/interactions, not duplicate same-scope
   work. High-risk scopes add distinct lenses. Synthesize one verdict; send
   merged fixes to the original live session; loop fix -> re-verify (same
   Reviewer + Lead re-check) until clean. Debugger first for requested debugging
   or a bug surviving 2+ fix cycles. Lead-direct 1-step fixes still require
   shell self-verification before report. Agent reports relay scope, verdict, next
   work as in-progress, never conclusions.
4. Report: final (not interim) report compares work to approved plan and gives
   verified result; never forward raw agent output. Ask about ship/deploy when
   relevant. Build/deploy/commit/push require an explicit user request after
   issue-free feedback; implementation approval alone is insufficient.

On outcome/direction change, pause and re-consult; otherwise continue approved
work without reapproval.
