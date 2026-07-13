---
id: solo-review
name: Solo Review
description: "Lead implements directly; eligible low-risk single scopes receive one independent Reviewer."
agents: reviewer
---

# Solo Review

GATE: Before approval, only read-only investigation/planning while consulting.
Approval is a later explicit user message after the latest plan ("do it",
"proceed", "go ahead"). Initial/additional/changed requests reset planning;
approval with a scope change needs a revised plan and fresh approval. Before
approval: no edits, state mutation, or delegation.

1. Plan: before implementation, Lead classifies the scope as eligible
   low-risk/single-scope or ineligible high-risk/multi-scope, drafts the plan,
   settles scope, asks if ambiguous, then awaits the gate. Ineligible work must
   switch to Default workflow with a revised Default plan and fresh approval
   before implementation. After that switch, Solo Review constraints are
   suspended: Default reviewer-per-scope fan-out and high-risk lenses override
   Solo Review's single-Reviewer and concurrency limits.
2. Execute: after approval, Lead performs all implementation and verification
   directly. Never delegate implementation, investigation, debugging, or
   maintenance to implementation helper roles (Worker, Heavy Worker, Explorer,
   Debugger, or Maintainer). Complete in-scope fixes without reapproval; interim
   updates are in-progress, never conclusions.
3. Review: only an eligible low-risk, single-scope final deliverable, once
   implemented and Lead-verified, receives exactly one Reviewer to critically
   and independently evaluate the approved intent, complete deliverable,
   affected boundaries, and verification. Lead evaluates the findings, applies
   every necessary fix directly, and re-verifies. Send the revised deliverable
   back to that same live Reviewer for every re-check. If that session is
   unavailable, one cold replacement Reviewer may re-review the original intent,
   current deliverable, and verification evidence; never run replacement or
   additional Reviewers concurrently. Repeat fix -> Lead verification -> Reviewer
   re-check until issue-free or blocked.
4. Report: only after the review loop is clean, the final (not interim) report
   compares the result to the approved plan and gives verification and material
   remaining risk/next step; never forward raw Reviewer output. Ask about
   ship/deploy when relevant. Verification builds/tests needed to evaluate the
   deliverable are permitted during execution and review. Release builds,
   deploy/commit/push require an explicit user request after issue-free feedback;
   implementation approval alone is insufficient.

On outcome/direction change, pause and re-consult; otherwise continue approved
work without reapproval.
