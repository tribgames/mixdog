# Tool Use

- Before the first call, gather every known facet in one tool message; for
  each facet choose exactly one shortest locator route:
  broad/uncertain→`explore` (roles without it: `find`); partial path/name→
  `find`; verified root+wildcard→
  `glob`; quoted/non-identifier literal or regex→`grep`; exact code
  identifier/relation→`code_graph` before grep; known file/span→`read`
  directly without `grep`; verified directory→`list`; edit→`apply_patch`;
  program/state change→`shell`; web/current external info→`search`. Use grep
  only for a requested literal occurrence or after graph zero/error.
- Batch compatible targets and combine variants, symbols, scopes, paths, and
  queries. Parallelize distinct facets only, never alternative routes for one
  facet. Put independent read-only calls in one turn; they may run
  concurrently regardless of tool. Later turns are only for targets dependent
  on prior results or unresolved facets. Shell/write calls are serial.
- After locator results, collect all known candidate files/regions before
  inspection. Batch compatible reads, including same-file regions, in one
  `path[]` call and graph targets in arrays. Parallelize independent
  incompatible read-only inspections. Do not start a singleton while a known
  compatible candidate remains. Put all known edits in one patch.
- Project root, session cwd, user-provided and tool-returned paths are
  verified. Use `find` first for every genuinely guessed path/name fragment, in
  the same turn as independent probes. Never find verified roots or use
  `path:"."` with guessed `src/**`. On ENOENT, find the basename; never retry
  the guess. Unscoped root grep/glob/list requires no find.
- At task start, batch all `explore` facets in one `query[]` call, maximum 8,
  without rephrased duplicates. Retry `EXPLORATION_FAILED` once with changed
  tokens.
- Stop when evidence covers the deliverable; never re-locate, re-verify,
  refine, or upgrade a sufficient anchor. Every returned requested `path:line`
  freezes the LOCATION only. When content was not returned, read or
  code_graph detail inspection is valid; never re-locate it.
- Give grep content mode enough `-C` to avoid rereads; a sufficient contextual
  grep means no overlapping `read`. After `files_with_matches`, `count`,
  capped, or insufficient context, inspect only missing content. A nonzero
  `content_with_context` result resolves the concept; act directly without
  token changes, narrowing, or re-search. Only zero/error results permit token
  or scope changes.
- Batch independent read files/regions as real arrays, using
  `{path,offset,limit}` regions, and read the whole logical unit. Never page or
  reread returned spans.
- Apply edits before verification, then verify in a separate shell turn and
  consume results in order. Otherwise remain parallel.
- A long-running command promoted to background is a decision point, not a
  cue to wait. Estimate whether observed progress can finish within budget;
  otherwise diagnose the bottleneck and switch routes. Choose waiting
  explicitly.
