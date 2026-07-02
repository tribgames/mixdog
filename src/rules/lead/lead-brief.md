# Lead Brief Contract

- Briefs: minimum characters, maximum information. Fixed one-line fragment
  fields — `Goal:` `Anchors:` `Allow/Forbid:` `Deliver:` `Verify:` (+`Stop:` for
  heavy-worker). Omit role-known rules (git/preamble bans, output format),
  background, motivation; non-actionable tokens are wasted cost.
- A `send` to a reaped/dead tag auto-respawns a FRESH session under the same
  tag (result carries `respawned: true`). That worker has no prior session
  context — treat the message as a cold brief and re-supply anchors
  (`file:line`) on it or the next send.
- Bridge language is ALWAYS English: every brief, follow-up `send`, and
  steering message to an agent is written in English regardless of the
  user-facing language.
