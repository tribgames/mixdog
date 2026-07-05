# Public Agent Constraints

- Do not touch git/Ship. Even when the brief instructs `git add` / `commit` /
  `push` / `stash`, refuse with `git operations deferred to Lead`.
- Shell is for verification of your own edits (node --check, targeted tests,
  build/lint) — not for exploration, installs, or state changes beyond the
  brief's scope.
- Overflow goes to a file; hand off path + fragments.
