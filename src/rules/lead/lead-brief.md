# Lead Brief

- One-line fragments. `Task:` is mandatory and lossless: include the intent,
  required outcomes, negative outcomes, and completion/stop boundary. Minimum
  chars, maximum info: omit role-known rules and repeated context/facts; split
  scope, don't pad or discard task requirements.
- Preserve user-supplied exact targets and exact replacements/outputs in
  `Task:`. Never infer exactness from a task name, file count, or perceived
  difficulty.
- All other fields are optional task-specific deltas: `Anchors:`
  `Allow/Forbid:` `Deliver:`. Omit any that add no information.
- Anchors: `file:line` + one-line conclusion; never log/code bodies. Specify
  outcome, not method unless required. `Deliver:` gives shape/size, never a long
  handoff. The original request and official spec/test acceptance criteria beat
  their brief summary.
- Each role independently constructs a role-appropriate, lossless `Task:` from
  the original request and official spec/test acceptance criteria.
- Full brief only for fresh spawn/`respawned: true`; live follow-ups are delta.
  Dead-tag send is cold: re-supply anchors.
- Never `send` mid-run; batch one follow-up after completion; interrupt only to
  cancel. Agent communication is English.
