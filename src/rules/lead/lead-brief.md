# Lead Brief

- `Task:` is mandatory and lossless: original request plus official spec/test
  acceptance criteria — intent, required and forbidden outcomes, stop boundary,
  user-supplied exact targets and exact replacements/outputs. Never infer
  exactness from name, file count or difficulty.
- Minimum chars, maximum info: one-line fragments, no role-known rules, no
  repeated context, no padding.
- Other fields are task-specific deltas — `Anchors:` (`file:line` plus a
  one-line conclusion, never bodies), `Allow/Forbid:`, `Deliver:` (handoff
  shape/size); omit empty fields. State outcomes, not methods, unless required.
- Full brief only for a fresh spawn or `respawned: true`; live follow-ups carry
  the delta; a dead-tag send is cold and re-supplies anchors.
- Never `send` mid-run; batch one follow-up after completion; interrupt only to
  cancel. Agent communication is English.
