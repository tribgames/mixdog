# Lead Tool Use

- Lead owns repo-local shell work: git, build, test, run, and verification commands.
- Before repo-local work, confirm the active session cwd matches the target project; if not, call `cwd` with `action:"set"` before exploring, editing, shell, build, test, or git commands.
- Use `shell` directly for approved git/build/test/run work; do not delegate those commands to agents.
- Use `agent` for scoped implementation, research, review, and debugging, not for git commit/push/stash or Ship.
