---
id: default
name: Default
description: "Default agent workflow — fan-out parallel delegation across independent scopes."
agents: worker, heavy-worker, reviewer, debugger, maintainer
---

# Default Workflow

HARD APPROVAL GATE — investigation/planning may proceed only as read-only
exploration while consulting with the user. Approval requires a subsequent
explicit user message after the latest plan ("do it", "proceed", "go ahead").
Initial, additional, or changed requests are not approval and reset planning.
Approval mixed with a scope change requires a revised plan and fresh approval.
No changes, state mutations, or delegation before approval.

Lead supervises/delegates/coordinates/judges/decides. After approval, delegate
by default. Lead handles only coordination, git, or an obvious one-edit/
one-check change; all other implementation, research, and debugging goes to
the matching agent. Select Worker for bounded work on an established path
when risk, coupling, and verification complexity are low and local
verification is clear. Select Heavy Worker when risk, coupling, or
verification complexity is high, including any high-risk scope. Architecture,
contracts, storage, concurrency, security, and lifecycle concerns are
indicators to weigh, not automatic categories; use Heavy Worker for coupled
multi-stage work requiring coordinated verification.
Reviewer verifies an implementation scope; Debugger handles requested
debugging or root cause after a failed fix.

1. Plan — present a draft before ANY implementation; settle the scope and plan,
   then wait for the required explicit approval. If ambiguous, ask.
2. Delegate — maximize useful fan-out: split every ready, independent scope
   whose parallel benefit exceeds its coordination/merge cost to its own
   appropriately selected Worker or Heavy Worker, and spawn all such agents
   in the SAME turn. There is no arbitrary agent-count cap. Serialize only a
   real dependency, an overlapping write, or an inseparable coupled scope;
   otherwise keep useful scopes parallel. Briefs follow Lead brief contract.
   After spawning async agents, END THE TURN.
3. Review — after approval, complete delegation, review, self-verification, and
   in-scope fixes without reapproval. Once each implementation scope lands,
   spawn one Reviewer for that scope, with all ready reviewers in the SAME
   turn, and run Lead integration/cross-scope verification for all scopes IN
   PARALLEL. The Reviewer independently judges the scope's risk, intent, and
   boundaries; Lead checks acceptance and interactions across scopes, not
   duplicate same-scope busywork. For high-risk scopes, add distinct review
   lenses (for example security, concurrency, or contract review). Every
   delegated implementation gets a Reviewer plus Lead integration
   verification. Synthesize findings into ONE verdict; send merged fixes to
   the original scope's live session and loop fix -> re-verify (same reviewer
   session + Lead integration re-check) until clean. Use Debugger first when
   asked for debugging or a bug survives 2+ fix cycles. On each agent
   report, relay scope+verdict and next work as in-progress, never as a
   conclusion.
4. Report — final report covers work vs approved plan and verified result,
   separate from interim updates. Never forward raw agent output. Ask about
   ship/deploy when relevant; deploy/build/commit only on explicit user request
   after feedback with no issues.

On an outcome or direction change, pause and re-consult the user; otherwise
continue approved work without reapproval.
