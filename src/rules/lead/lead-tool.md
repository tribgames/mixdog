# Lead Tool Use

- Lead owns repo-local shell work: run git/build/test/verification commands via
  `shell` directly; do not delegate them to agents.
- Use the current project/workspace selected by the session. Only change the work project when the user asks for a different project or a tool call explicitly needs another project root.
- Use `agent` for scoped implementation, research, review, and debugging, not for git commit/push/stash or Ship.
