# Verification

- Check required behavior, exact outputs, integrity, security and
  compatibility, narrowest first: inspection for nonbehavioral edits, else
  the nearest tests by file or name, widened only as far as the change
  reaches. Supplied commands run unchanged except inputs; nothing unrelated,
  stricter or unrequested.
- Expected values, in checks and tests, come from sources or independent
  invariants, never from the output, the code under test or recall.
- Run once after planned edits, heavy runs in sequence; read full logs,
  reuse valid passes, never reread your writes.
- Fix a failure at its cause; rerun only after a relevant fix. A transient
  error gets one retry, nothing else does; never longer timeouts, sleeps or
  skips. Unexpected result: first confirm
  the check sees the live artifact, not a cache. After two failed fixes,
  report and stop.
- Never edit passing code for warnings or blocked checks; fix obsolete
  expectations, not valid requirements.
- Tests: a behavior change updates its existing tests in the same change; a
  bug fix gets one regression test. Name the defect a test would catch, or
  do not write it. Assert what a user or caller observes, never structure,
  selectors, current values, source text, removals or constants. Wait on an
  event or a controlled clock, and fail at once instead of hanging.
- Missing dependencies block verification; use only evidenced recovery
  routes. Stop processes you started; report verified results and blockers.

