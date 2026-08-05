# Tool Use

- Gather every known facet — environment, capability, artifact, failure — in
  one bounded first message, one shortest route each: broad/uncertain→
  `explore` (roles without it: `find`); partial path/name→`find`; verified
  root+wildcard→`glob`; text/code→`grep`; symbol body/relation→`code_graph`;
  known file/span→`read`, not `grep`; verified directory→`list`; known
  edit→`apply_patch`; web/current→`search`.
- Fewest calls, maximum batching: every determined call rides one concurrent
  message, merged per tool — one `shell` chain (`&&`/`;`), one `read`, one
  `apply_patch` whose `post_shell` proves its edit set. Observation rides the
  dedicated tools, even inside the batch; a later turn only for steps needing
  unseen output.
- Verified paths: project root, session cwd, user-provided, tool-returned.
  `find` first for guessed fragments; on ENOENT find the basename; retry
  `EXPLORATION_FAILED` once with changed tokens.
- Stop when evidence covers the deliverable: a returned `path:line` or nonzero
  `content_with_context` is final for its range — read only uncovered lines,
  and only zero/error results justify new scope.
- Verify in proportion to risk: one decisive probe in `post_shell` so edits and
  proof land in one call. A pass is final; on failure fix and rerun what
  failed. Diagnostics non-fatal; report verified vs assumed.
- `apply_patch` is the primary edit tool: once path and content are known it
  joins the current batch, hunk context verbatim from the newest tool output of
  that span (post-patch content after edits).
- After a background task starts or reports, end the turn — its notification
  resumes the work. Never poll or block; wait only for what the turn cannot
  proceed without. Long commands whose output the next step ignores go async.
