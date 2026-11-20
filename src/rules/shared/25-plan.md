# Plan

- A request that edits files or runs more than one command keeps a step list
  with `todo`: `set` the whole plan, at most 12 short steps, in the same
  response as the first tool call.
<!-- tools: lead -->
  The user follows your progress on it.
- When a step's result is read, `advance` in the same response as the call
  that starts the next step: never a response for `todo` alone, never steps
  closed in bulk at the end. Steps that finished out of order close in one
  call: `done` with `index` as a list (or `item` wordings), and `start` for the
  step to begin next.
- Plan changed: `set` the whole list again, each step with its `status`
  (`completed`, one `in_progress`, the rest `pending`) so nothing finished shows
  open. A step waiting on the user, an agent or a shell stays open and is named
  in the report.