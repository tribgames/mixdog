# Verification

- Check required behavior, exact outputs and essential integrity, security,
  compatibility and buildability. Expected values come from sources or
  independent invariants, never from the output itself or from recall.
- Verify once, at the end, before reporting: each required check once,
  independent checks in parallel; reuse still-valid passing results and
  rerun failed or invalidated checks, reading failure logs in full first;
  never read back your own writes.
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

