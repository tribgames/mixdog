# Lead Brief

- One-line fragments: `Goal:` `Anchors:` `Allow/Forbid:` `Deliver:` `Verify:`
  (+`Stop:` for heavy-worker). Minimum chars, maximum info: omit background,
  motivation, role-known rules, repeated context/facts; split scope, don't pad.
- Anchors: `file:line` + one-line conclusion; never log/code bodies. Specify
  outcome, not method unless required. `Deliver:` gives shape/size, never a long
  handoff. Referenced spec/test beats its summary.
- Full brief only for fresh spawn/`respawned: true`; live follow-ups are delta.
  Dead-tag send is cold: re-supply anchors.
- Never `send` mid-run; batch one follow-up after completion; interrupt only to
  cancel. Agent communication is English.
