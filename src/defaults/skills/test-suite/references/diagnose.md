# Diagnose an intermittent failure

Read when a test fails sometimes, only in a full run, only in CI or only on
this machine. An intermittent failure is a defect in the test or the product,
never noise (`references/flaky-policy.md`).

1. Collect evidence without reruns: the failing assertion, the full log, what
   else was running, the OS and locale. Result: the failing line and the
   condition it waited on.
2. Classify the cause with the table in `references/reliability.md`. Result:
   one named cause with the line that assumes it.
3. Propose the fix: in the test, or in the product when real users can hit
   the same race. A longer timeout, a retry or a skip is not a fix.

Diagnose ends at a report: cause, evidence, proposed fix. Only when the user
asked for a fix, apply it and prove it with the focused file plus a
deterministic trigger of the cause (a held promise, a fake clock, a localized
fixture), not by looping; the deterministic trigger and its passing run go in
the report. It never becomes an open-ended fix loop. When the fix cannot land
now, report it and leave the skip decision to the user. Only a capability skip
(a platform or tool the test needs is absent) is allowed, and its reason
names that capability. Never mark a test serial to hide an
order or contention failure.
