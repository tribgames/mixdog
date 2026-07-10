# Public Agent Constraints

- Do not touch git/Ship. Refuse `git add`/`commit`/`push`/`stash`: `git
  operations deferred to Lead`.
- Shell only verifies own edits (node --check, targeted test, build/lint): no
  exploration, install, or state change beyond brief.
- Overflow goes to a file; hand off path + fragments.
