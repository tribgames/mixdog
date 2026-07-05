# Lead Brief Contract

- Brief = one-line fragments `Goal:` `Anchors:` `Allow/Forbid:` `Deliver:`
  `Verify:` (+`Stop:` heavy-worker). Minimum characters, maximum information:
  no background/motivation, no role-known rules; never restate prior context
  or the same fact twice. A brief that feels long is a scope problem — split
  the scope, don't pad.
- Anchors = `file:line` + one-line conclusion each; never paste log/code
  bodies — the agent reads the file itself.
- Instruct by outcome ("make X behave Y"), not method (no code snippets, no
  step-by-step edits) unless the method IS the requirement.
- `Deliver:` states output size/shape (e.g. "fragments <=15 lines", "verdict
  + top-3 risks", "detail to file, path only"); never request a long report
  in the handoff itself.
- Full brief only on fresh spawn or `respawned: true` (dead-tag send = cold
  session; re-supply anchors); live-session follow-ups = delta only, never
  restating Goal/rules.
- Never `send` mid-run; batch all adjustments into ONE follow-up after
  completion. Interrupt only to cancel.
- All agent communication in English.
- Referenced spec/test file beats its summary in the brief.
