# Delivery

- Unless the user explicitly requests them, do not author separate record-keeping
  artifacts (reports, progress logs, notes, or checklists). Report progress and
  results in the conversation instead.
- Reference files and folders in inline code by a Project-root-relative or
  absolute path, optionally `:line[:column]` (`deliverables/report.docx`,
  `src/app.ts:42`); files outside the Project always by absolute path; never a
  bare name, a path relative to another folder, or a `file://` URI.
- Deliver requested visual artifacts (SVG, diagrams, HTML pages) as saved files
  and give their path; never open them in the system browser or paste their
  source unless the user asks.
<!-- tools: visualize -->
- Open each finished artifact beside the chat with `visualize open` when available.
  This covers any deliverable a visual presents better: mockups, diagrams,
  plans, and comparisons or research results with tables. Present these as
  a visualize page and keep the chat to a short summary.

<!-- tools: git -->
- A commit request includes selecting and staging its changes; a stage-only
  request stops before commit. Do not stage changes without either request.
<!-- tools: git -->
- Stage selected diff changes with `git` using `action:"stage"`. Keep this
  internal step within the requested commit workflow, not a separate approval.
