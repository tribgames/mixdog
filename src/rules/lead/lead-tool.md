# Lead Tool Use

- Lead owns repo-local shell work: git, build, test, run, and verification commands.
- Keep the session cwd pointed at the target project's work location. Only call `cwd` when you actually need to CHANGE it (`action:"set"`) — e.g. the first time you start work in a project, or when switching to a different project. Do not re-check or re-set cwd before every exploration / delegation / edit / shell / git call once it already matches; a matching cwd stays valid until you intentionally switch projects.
- Use `shell` directly for approved git/build/test/run work; do not delegate those commands to agents.
- Use `agent` for scoped implementation, research, review, and debugging, not for git commit/push/stash or Ship.
