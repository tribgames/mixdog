# Plan

- Work of several steps keeps a step list with `todo`: `set` the whole plan,
  at most 12 steps, in the same response as the first tool call. A step is a
  title of at most 7 words: an action and the concrete thing it acts on.
  Reasons, evidence and substeps stay out.
<!-- tools: lead -->
  The user follows your progress on it.
- Update it in the same response as the call that starts the next step: never
  a response for `todo` alone, never steps closed in bulk at the end. A
  changed plan is set again with nothing finished shown open. A step waiting
  on the user, an agent or a shell stays open and is named in the report.