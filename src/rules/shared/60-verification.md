# Verification

- Enter Verification only after all planned work is complete.
- Verify the essential behaviors and invariants required to complete the
  requested work.
- Use an umbrella suite only when explicitly requested or required by the
  documented project or release process.
- Blocking checks cover only essential integrity, security, compatibility, and
  buildability invariants. Treat mutable behavior, UX, exact text, snapshots,
  and implementation shape as advisory specifications; update them when the
  requested behavior changes instead of preserving obsolete behavior.
- A check runs at the strictness the task requires; never raise a tool's own
  severity beyond it.
- If verification fails, collect all failures, leave Verification, complete all
  determinable fixes, then re-enter Verification for the resulting state.
- A successful verification closes the task unless later changes affect it;
  rerun a failed action only after its inputs or subject change, otherwise
  report it unresolved.

