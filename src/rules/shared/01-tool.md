# Tool Use

- Before the first call, gather all presently-known facets in one tool message;
  for each facet choose exactly one shortest locator route: broad/uncertain→
  `explore`; partial path/name→`find`; verified root+wildcard→`glob`;
  quoted/non-identifier literal or regex→`grep`; exact code identifier/relation→
  `code_graph` before grep (grep only for a requested literal occurrence or
  after graph zero/error). Batch compatible targets; parallelize distinct facets
  only, never alternative routes for one facet. Known file/span→`read`;
  verified directory→`list`;
  edit→`apply_patch`; program/state change→`shell`; web/current external
  info→`search`.
- Put independent read-only calls in one turn; they may run concurrently
  regardless of tool. Later turns are only for targets dependent on prior
  results or unresolved facets. Shell/write calls are serial and dependencies
  are serialized. Combine variants, symbols, scopes, paths and queries in one
  call. After locator results, collect all known candidate files/regions before
  inspection; batch compatible reads, including same-file regions, in one
  `path[]` call and graph targets in arrays. Parallelize independent
  incompatible read-only inspections; do not start a singleton while a known
  compatible candidate remains. Put all known edits in one patch.
- Project root, session cwd, user-provided and tool-returned paths are
  verified. For a genuinely guessed path/name fragment, use `find` first
  (same turn as independent probes); do not find verified roots or use
  `path:"."` with guessed `src/**`. ENOENT→find the basename, never retry the
  guess. Unscoped root grep/glob/list needs no find.
- At task start, `explore` facets (implementation, config, tests, errors, ...)
  go in one `query[]` call (max 8, parallel), never rephrased duplicates;
  on `EXPLORATION_FAILED`, retry once with changed tokens.
- Stop when evidence covers the deliverable; never re-locate, re-verify,
  refine or upgrade a sufficient anchor.
  Every returned requested `path:line` freezes the LOCATION only; read or
  code_graph detail inspection is valid when content was not returned, but
  never re-locate it. Content_with_context with sufficient context is
  actionable directly.
- Grep content mode needs enough `-C` context to avoid rereads; sufficient
  contextual grep means no overlapping `read`. `files_with_matches`, `count`,
  capped, or insufficient context may inspect only missing content. Known
  file/span→`read` directly without `grep`; A nonzero `content_with_context`
  result resolves that search concept: act directly, without regex tweaks,
  narrowing or re-search. Only zero/error results may change tokens/scope.
- `read` batches independent files/regions as real arrays (regions are
  `{path,offset,limit}`), and reads the whole logical unit; do not page or
  reread returned spans. A third window means the first was too narrow.
- One carve-out to parallel-first: apply the edit, then verify it in a
  separate shell turn and consume results in order. Otherwise stay parallel.
