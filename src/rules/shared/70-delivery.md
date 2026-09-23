# Delivery

- Unless the user explicitly requests them, do not author separate record-keeping
  artifacts (reports, progress logs, notes, or checklists). Report progress and
  results in the conversation instead.

<!-- tools: git -->
- A commit request includes selecting and staging its changes; a stage-only
  request stops before commit. Do not stage changes without either request.
<!-- tools: git -->
- Stage selected diff changes with `git` using `action:"stage"`. Keep this
  internal step within the requested commit workflow, not a separate approval.
