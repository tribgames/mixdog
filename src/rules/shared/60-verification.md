# Verification

- Check required behavior, exact outputs and essential integrity, security,
  compatibility and buildability. Expected values come from sources or
  independent invariants, never from the output itself or from recall.
- Match checks to the change: inspection for nonbehavioral edits, focused
  tests for local behavior, broader lanes only for shared contracts. Run them
  once after planned edits, heavy ones in sequence; never reread your writes.
- Read full logs; rerun only after a relevant fix, never masking a failure
  with retries, timeout bumps or skips; reuse valid passes.
  After two failed fixes, report and stop. Stop processes you started.
- Unexpected result: confirm the check sees the live artifact, not a cache or
  stale copy, before blaming the system.
- Use supplied commands unchanged except inputs; no stricter flags or
  unrequested suites.
- Warnings or blocked checks never justify editing passing code. Fix obsolete
  expectations, not valid requirements. A bug fix gets one regression test;
  tests assert behavior, never removals, constants or copied code.
- Missing dependencies block verification; use only evidenced recovery routes.
  Report verified results and blockers.

