# Tool Use

- Batch independent calls in one turn; serialize only when a call needs a
  prior result. Merge equivalent variants/scopes into ONE call wherever the
  schema accepts arrays (`pattern[]`, `path[]`, `symbols[]`, `query[]`).
- Route by what is already known: known symbol/relation → `code_graph`;
  exact text in a known scope → `grep`; unknown location or concept-level
  question → `explore`; name fragment → `find`; exact name pattern → `glob`;
  known directory → `list`; known file/region → `read`.
- Valid anchors come from user input or tool output in this session; locate
  anything else with `find` before `grep`/`read`. On ENOENT the next call is
  `find` on the basename — never a retried guess.
- Retrieval stops when evidence covers the deliverable: single-answer tasks
  end at the first sufficient anchor; enumeration tasks (review, audit) end
  when the stated scope is covered. Never re-verify a hit already on screen;
  a plausible anchor means the next call is the action itself
  (patch/answer/handoff) — never "one more confirming read".
- Content-mode `grep` requests enough context (`-C`) to act without
  re-reading the same file; bare match lines are existence checks only.
- Repeat a search concept only after a zero-result call, changing tokens or
  scope — never wording alone.
- `read` windows use `offset`/`limit`; multiple spans or files = ONE call
  with `{path,offset,limit}[]` regions. Size the window to the whole logical
  unit (function/section) — over-read once instead of paging the same file
  in small windows across turns; a 3rd window into one file means the first
  should have been wider.
- Don't mix `apply_patch` with shell or other state-changing calls in one turn.
