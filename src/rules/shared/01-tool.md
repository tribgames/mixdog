# Tool Use

- BATCH OR IT IS A DEFECT — this is the single hardest rule here. Every turn
  fires ALL independent calls at once; a second consecutive single-lookup,
  single-`shell`, or single-`apply_patch` turn is a defect, never a style
  choice. Serialize ONLY on a real data dependency — nothing else earns a
  solo call. Merge variants/scopes into ONE call wherever the schema takes
  arrays (`pattern[]`, `path[]`, `symbols[]`, `query[]`), chain shell with
  `;`/`&&` or run them in parallel, and put every known edit in ONE patch.
- Route by verified inputs: symbol/relation → `code_graph`; exact text in a
  verified scope → `grep`; unknown/out-of-repo/machine-wide location or concept
  → `explore`; name fragment → `find`; exact pattern → `glob`; verified dir →
  `list`; verified file/span → `read`.
- `explore` fan-out: at task start, decompose what the task needs to know
  into independent facets (implementation site, config/load path, tests,
  error origin, ...) and send them as ONE `query[]` call — facets run in
  parallel. Never fan out rephrasings of the same target; on
  EXPLORATION_FAILED, retry once with changed tokens.
- Verified = user-provided, tool-returned, or the session project cwd itself.
  Unscoped grep/glob/list from the project root needs NO find hop; find only
  resolves a genuinely guessed path-name fragment, and it rides the SAME turn
  as independent probes (unscoped grep, code_graph) — never a solo
  path-verification turn. ENOENT → `find` basename, never retry a guess; don't
  mask a miss with a guessed glob scope (path "." + `src/**`) or an invented
  absolute path, but plain project-root searches are fine.
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
  can't react to a failed or partial patch. Put all known edits in ONE patch
  this turn, in the order they should apply; later mutations skip after an
  earlier patch failure. Verify all edits in ONE shell call next turn. Anything
  else stays parallel.
