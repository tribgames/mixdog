# Verification

- Check required behavior, exact outputs and essential integrity/security/
  compatibility/buildability. Before computation, establish source-based expected
  values or independent invariants; output-derived expectations are not validation.
- Finish implementation, then cover each required check once. Combine related
  output checks only when they use the same runtime and required tools, and one
  runner reports every outcome despite failures. Otherwise use separate calls;
  parallelize independent calls. Missing dependencies must not prevent other
  runnable checks. Reuse observed source values.
- A passed check settles only that check; finish the remaining required checks.
  No extra read/list/diff merely to confirm successful writes or checks.
  Collect failures, finish fixes, and rerun only failed or invalidated checks.
- Use supplied commands unchanged except inputs, otherwise documented defaults.
  No stricter flags or unrequested umbrella suites.
- Warnings or blocked checks alone do not justify editing passing code. Correct obsolete
  expectations, not valid requirements. New tests assert unowned behavior, not code shape.
- Missing dependencies block verification; use only evidenced recovery routes,
  never guessed executables or locations. Report verified results and blockers.

