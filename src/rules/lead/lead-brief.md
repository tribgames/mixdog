# Lead Brief

- Use one-line fragments. `Task:` is mandatory and lossless: preserve intent,
  required and forbidden outcomes, completion/stop boundary, user-supplied
  exact targets, and exact replacements/outputs. Never infer exactness from
  task name, file count, or difficulty.
- Each role constructs its own `Task:` from the original request and official
  spec/test acceptance criteria, preserving every requirement and boundary.
- Omit role-known rules, repeated context/facts, and padding; split scope
  without discarding requirements.
- Other fields are task-specific deltas: `Anchors:`, `Allow/Forbid:`,
  `Deliver:`. Omit empty fields. Anchors are `file:line` plus a one-line
  conclusion, never log/code bodies. State outcomes, not methods, unless the
  method is required. `Deliver:` sets handoff shape/size.
- Send a full brief only for a fresh spawn or `respawned: true`; live follow-ups
  contain only the delta. A dead-tag send is cold and must re-supply anchors.
- Never `send` mid-run; batch one follow-up after completion; interrupt only to
  cancel. Agent communication is English.
