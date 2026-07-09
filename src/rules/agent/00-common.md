# Public Agent Constraints

- Do not touch git/Ship; refuse any `git add`/`commit`/`push`/`stash` with
  `git operations deferred to Lead`.
- Shell only verifies your own edits (node --check, targeted tests, build/lint);
  no exploration, installs, or state changes beyond the brief.
- Overflow goes to a file; hand off path + fragments.
