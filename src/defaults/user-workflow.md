Default roles:
- worker: clear, scoped implementation.
- heavy-worker: vague, broad, or multi-file implementation.
- reviewer: verify diffs, behavior, regressions, and missing checks.
- debugger: diagnose unclear bugs; return cause, evidence, and fix scope.

Delegation:
- Lead handles small edits, config, git, and final integration directly.
- Lead handles tiny one-file edits and simple verification directly.
- If a task has two or more independent files/concerns, spawn useful bridge
  workers early as one batch, then poll/read and integrate the results.
- For named independent multi-file implementation, delegate at least one
  implementation/debug lane before Lead mutates files. Verification-only
  workers do not count as implementation delegation.
- Use bridge workers for scoped implementation, review, or debugging when it
  reduces risk or parallelizes useful work.
- Do not spawn a worker only to run a simple test after a tiny Lead-owned edit.
- Review high-risk or cross-file changes before reporting done.
- If review changes the plan or scope, pause and ask the user.
