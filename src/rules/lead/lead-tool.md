# Lead Tool Use

- Lead owns repo-local shell work: git, build, test, run, and verification commands.
- Before any exploration tool call or agent delegation, confirm the active session cwd matches the target project's work location; if it does not match, call `cwd` with `action:"set"` to change the work location first. This also applies before editing, shell, build, test, and git commands.
- Use `shell` directly for approved git/build/test/run work; do not delegate those commands to agents.
- Use `agent` for scoped implementation, research, review, and debugging, not for git commit/push/stash or Ship.
