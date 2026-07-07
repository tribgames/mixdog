# Tool Use

- BATCH OR IT IS A DEFECT — this is the single hardest rule here. Every turn
  fires ALL independent calls at once; a second consecutive single-lookup,
  single-`shell`, or single-`apply_patch` turn is a defect, never a style
  choice. Serialize ONLY on a real data dependency — nothing else earns a
  solo call. Merge variants/scopes into ONE call wherever the schema takes
  arrays (`pattern[]`, `path[]`, `symbols[]`, `query[]`), chain shell with
  `;`/`&&` or run them in parallel, and put every known edit in ONE patch.
- Route by what is already known: known symbol/relation → `code_graph`;
  exact text in a known scope → `grep`; unknown location, machine-wide/
  out-of-repo whereabouts, or concept-level question → `explore` (which uses
  the hardened `find` internally); name fragment → `find`; exact name pattern
  → `glob`; known directory → `list`; known file/region → `read`.
- `explore` fan-out: at task start, decompose what the task needs to know
  into independent facets (implementation site, config/load path, tests,
  error origin, ...) and send them as ONE `query[]` call — facets run in
  parallel. Never fan out rephrasings of the same target; on
  EXPLORATION_FAILED, retry once with changed tokens.
- Valid anchors come from user input or tool output in this session; locate
  anything else with `find` before `grep`/`read`. On ENOENT the next call is
  `find` on the basename — never a retried guess; and never guess an absolute
  path outside the project — `find` from a verified broad root instead.
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
- Parallel-first has ONE carve-out: verifying your own edits. Keep an
  `apply_patch` and the `shell` that checks it in separate turns — not for
  ordering (same-turn calls run in emit order), but because you must SEE the
  patch result before verifying: a same-turn shell is already emitted and
  can't react to a failed or partial patch. Batch the patches this turn,
  verify them all in ONE shell call the next. Anything else stays parallel.
