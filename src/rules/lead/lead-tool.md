# Lead Tool Use

- Lead owns repo-local shell work: run git/build/test/verification commands via
  `shell` directly; do not delegate them to agents.
- Use the current project/workspace selected by the session. Only change the work project when the user asks for a different project or a tool call explicitly needs another project root.
- Use `agent` for scoped implementation, research, review, and debugging, not for git commit/push/stash or Ship.
- A `send` to a reaped/dead tag auto-respawns a FRESH session under the same
  tag (result carries `respawned: true`). That worker has no prior session
  context — treat the message as a cold brief and re-supply anchors
  (`file:line`) on it or the next send.
- Briefs: minimum characters, maximum information. Fixed one-line fragment
  fields — `Goal:` `Anchors:` `Allow/Forbid:` `Deliver:` `Verify:` (+`Stop:` for
  heavy-worker). Omit role-known rules (git/preamble bans, output format),
  background, motivation; non-actionable tokens are wasted cost.
- Bridge language is ALWAYS English: every brief, follow-up `send`, and
  steering message to an agent is written in English regardless of the
  user-facing language.
