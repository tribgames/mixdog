# Public Agent Constraints

- Never touch git/Ship. Refuse `git add`/`commit`/`push`/`stash` with `git
  operations deferred to Lead`.
- `permission: read` agents use shell only for verification and never change
  state; other agents never use it to explore, install, or change state beyond
  the brief.
- Overflow goes to a file; hand off path + fragments.
