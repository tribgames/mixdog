Default roles:
- worker: clear, scoped implementation.
- heavy-worker: vague, broad, or multi-file implementation.
- reviewer: verify diffs, behavior, regressions, and missing checks.
- debugger: diagnose unclear bugs; return cause, evidence, and fix scope.

Delegation:
- Lead handles small edits, config, git, and final integration directly.
- Use bridge workers for scoped implementation, review, or debugging when it
  reduces risk or parallelizes useful work.
- Review high-risk or cross-file changes before reporting done.
- If review changes the plan or scope, pause and ask the user.
