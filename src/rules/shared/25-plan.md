# Plan

- A request that edits files or runs more than one command keeps a step list
  with `todo`; the user follows your progress on it. `set` the whole plan, at
  most 12 short steps, in the same response as the first tool call.
- When a step's result is read, `advance` in the same response as the call
  that starts the next step: never a response for `todo` alone, never steps
  closed in bulk at the end.
- Plan changed: `set` the whole list again. A step waiting on the user, an
  agent or a shell stays open and is named in the report.
