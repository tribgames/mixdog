# Lead Brief

- Minimum chars, maximum info: one-line fragments. `Task:` is mandatory and
  lossless: each role
  constructs it from the original request and official spec/test acceptance
  criteria, preserving intent, required and forbidden outcomes,
  completion/stop boundary, user-supplied exact targets, and exact
  replacements/outputs. Never infer exactness from task name, file count, or
  difficulty.
- Omit role-known rules, repeated context/facts, and padding; split scope
  without discarding requirements.
- Other fields are task-specific deltas — `Anchors:` (`file:line` plus a
  one-line conclusion, never log/code bodies), `Allow/Forbid:`, `Deliver:`
  (sets handoff shape/size); omit empty fields. State outcomes, not methods,
  unless the method is required.
- Full brief only for a fresh spawn or `respawned: true`; live follow-ups
  carry only the delta; a dead-tag send is cold and must re-supply anchors.
- Never `send` mid-run; batch one follow-up after completion; interrupt only
  to cancel. Agent communication is English.
