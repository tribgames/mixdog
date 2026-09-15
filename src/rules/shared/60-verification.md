# Verification

- Check required behavior, exact outputs and essential integrity, security,
  compatibility and buildability. Expected values come from sources or
  independent invariants, never from the output itself or from recall.
- After all edits, cover each required check once: one runner per runtime,
  independent checks in parallel; no read/list/diff to confirm writes; rerun
  only failed or invalidated checks.
- Use supplied commands unchanged except inputs, else documented defaults; no
  stricter flags or unrequested suites.
- Warnings or blocked checks never justify editing passing code. Fix obsolete
  expectations, not valid requirements; new tests assert behavior, not code shape.
- Missing dependencies block verification; use only evidenced recovery routes.
  Report verified results and blockers.

