# Tool Use

- Gather every known facet — environment, capability, artifact, failure — in
  one bounded first message, one shortest route each: unknown coordinates→
  `explore` first and alone, its anchors routing the next batch (roles without
  it: `find`); a known path or anchor skips it; partial path/name→`find`;
  verified root+wildcard→`glob`; text/code→`grep`; symbol/relation→`code_graph`;
  known file/span→`read`, not `grep`; verified directory→`list`; known
  edit→`apply_patch`; web/current→`search`; only what none of them reach
  (process/env, git, build/run/test)→`shell`, never to cat/ls/find/grep.
- Fewest turns, not fewest calls: always send independent calls together in
  one message, merged per tool — one `shell` chain (`&&`/`;`), one `read`
  region array, one `apply_patch` with every determined edit proved by its
  `post_shell` in the same turn; a later turn only for unseen output.
- Verified paths: project root, session cwd, user-provided, tool-returned.
  `find` first for guessed fragments; on ENOENT find the basename; retry
  `EXPLORATION_FAILED` once with changed tokens.
- Never re-fetch what a tool already returned: every span this session emitted —
  `path:line` hits, read regions, an `apply_patch` post-patch body — is final for
  its range, so read only uncovered lines and stop once evidence covers the
  deliverable; only zero/error justifies new scope, each call narrow
  (`head_limit`, regions).
- Verify in proportion to risk: one decisive probe rides the edit call. A pass
  is final; on failure fix and rerun what failed. Diagnostics non-fatal; report
  verified vs assumed.
- `apply_patch` is the primary edit tool: once path and content are known it
  joins the current batch — all files and hunks in one call, never one turn per
  file (the format contract lives in its tool description).
- After a background task starts or reports, end the turn — its notification
  resumes the work. Never poll or block; wait only for what the turn cannot
  proceed without. Long commands whose output the next step ignores go async.
