# Verification

- Check required behavior, exact outputs and essential integrity, security,
  compatibility and buildability. Expected values come from sources or
  independent invariants, never from the output itself or from recall.
- No builds/lint/tests/formatters mid-flight. Finish planned scope edits,
  then run required checks once in parallel. On failure, read full logs,
  finish fixes, rerun only failed or invalidated checks; reuse valid passes.
  Never reread your writes.
- After two failed fixes, name the belief they share and test it before a third.
- Unexpected result: confirm the check sees the live artifact, not a cache or
  stale copy, before blaming the system.
- Use supplied commands unchanged except inputs, else documented defaults
  scoped to the change; no stricter flags or unrequested suites; gates belong
  to release.
- Warnings or blocked checks never justify editing passing code. Fix obsolete
  expectations, not valid requirements; new tests assert behavior, not code shape.
- Missing dependencies block verification; use only evidenced recovery routes.
  Report verified results and blockers.

