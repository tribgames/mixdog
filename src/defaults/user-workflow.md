Default roles:
- Implementation → worker for clear, well-specified, mechanical changes of contained scope; heavy-worker when the brief is vague/open-ended or the change is bulk/multi-file. The axis is brief clarity + scope, not raw difficulty — a hard but well-specified, contained task still goes to worker. Pair either tier with a reviewer identically.
- Verification → reviewer. Debugging → debugger.

Who edits — delegate by default. Implementation and other state-changing edits go to a worker with a paired reviewer, even when the change looks small. The Lead edits directly only when all three hold: it already has full context from its own investigation, the change is genuinely small (a few lines across 1-2 files), and there is nothing else to parallelize. Lead-owned config and git work is always direct. When in doubt, or as soon as scope grows, delegate. A reviewer pairs 1:1 regardless of who made the edit.

Cross-verification loop (1:1 worker↔reviewer pairing is the default):
- The moment a worker finishes, first dispatch a reviewer scoped to its files, then immediately run the Lead self-check (syntax, diff, invariants) while the reviewer works. Parallel workers get parallel reviewers — reviews never queue behind one combined pass.
- When workers touched interacting files, the Lead does one thin integration pass directly (a Lead self-check, not another dispatched reviewer) to catch cross-file effects. Never collapse the paired reviewers into a single combined review.
- If a reviewer finds issues, dispatch a fix worker and re-pair it with a reviewer; repeat until every reviewer is clean ("ship-ready").
- If an issue requires changing the plan/spec rather than just fixing a bug, halt and report to the user; resume only after the plan is updated.
- Don't report completion before every reviewer's clean verdict. Mid-loop updates may share round/issue counts but must not claim done.

Fan-out (dispatching N agents in parallel) is a shared technique any role can use — worker, reviewer, debugger, explore. Use a debugger when a bug's root cause is unclear; plain code search and location stay explore's (explorer) job.
- For a hard bug (unknown cause, intermittent repro, multi-subsystem, or a fix worker's first attempt failed), fan out N debuggers, each investigating independently from a distinct angle (data flow, state/lifecycle, boundary/concurrency), blind to the others.
- Each debugger only diagnoses — root cause, minimal repro, proposed fix — and never implements. The Lead converges the diagnoses (agreement raises confidence, divergence triggers a cross-check), then hands the agreed cause to a fix worker paired 1:1 with a reviewer.
- Skip the fan-out for an obvious diff mistake — go straight to a fix worker.
