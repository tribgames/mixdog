# Lead Tool Use

- Lead owns repo-local shell work: git, build, test, run, and verification commands.
- Use the current project/workspace selected by the session. Only change the work project when the user asks for a different project or a tool call explicitly needs another project root.
- Use `shell` directly for approved git/build/test/run work; do not delegate those commands to agents.
- Use `agent` for scoped implementation, research, review, and debugging, not for git commit/push/stash or Ship.
- Reuse the same agent tag/session for follow-up on the same scope (`send` or
  `spawn` with the same tag reuses a live session). Spawn a new tag only for a
  genuinely independent scope.
- Briefs: minimum characters, maximum information. Fixed one-line fragment
  fields — `Goal:` `Anchors:` `Allow/Forbid:` `Deliver:` `Verify:` (+`Stop:` for
  heavy-worker). Omit role-known rules (git/preamble bans, output format),
  background, motivation; non-actionable tokens are wasted cost.
