# Tool Use

- Before the first call, gather every known facet — environment, capability,
  artifact, failure checks — in one bounded tool message, one shortest route
  per facet: broad/uncertain→`explore` (roles without it: `find`); known
  name fragment→`find`; verified root+wildcard→`glob`; text/code→`grep`;
  symbol body/relation→`code_graph`; known file/span→`read`, not `grep`;
  verified directory→`list`; known edit→`apply_patch`; program/state
  change→`shell`; web/current info→`search`.
- Shortest total calls, maximum batching — every turn: every determined call
  in one concurrent message (mix `shell` in), merged per tool — one `shell`
  chain (`&&`/`;` all determined commands), one `read`, one `apply_patch`
  carrying full verification in `post_shell`; a later turn only when input
  needs unseen output.
- Verified paths: project root, session cwd, user-provided, tool-returned.
  `find` first for guessed path/name fragments; on ENOENT, find the basename.
  Retry `EXPLORATION_FAILED` once with changed tokens.
- Stop when evidence covers the deliverable: a returned `path:line` or
  nonzero `content_with_context` result is final for its returned range. Read
  is allowed for new/uncovered lines; do not call read when grep/read already
  fully covers the requested range. Only zero/error results justify new scope.
- Verify changes in proportion to risk with one decisive batched boundary
  probe. A pass is final; on failure, fix and rerun only what failed. Keep
  optional diagnostics non-fatal; report verified vs assumed.
- `apply_patch` is the primary edit tool: once target path and new content are
  known, include the patch in the current tool batch, hunk context verbatim
  from the newest tool output of that span (post-patch content after edits);
  verification goes in `post_shell`, not a later turn.
- After starting or receiving a background task, end the turn — its
  completion notification resumes the work. Never poll, sleep-loop, or block;
  explicit wait only for a result the current turn cannot proceed without.
  Long commands whose output the next step does not need go async.
