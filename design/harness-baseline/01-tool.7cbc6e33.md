# Tool Use

- Before the first call, gather every known facet — environment, capability,
  artifact, and failure checks — in one bounded tool message. Use one shortest
  route per facet: broad/uncertain→`explore` (roles without it: `find`);
  partial path/name→`find`; verified root+wildcard→`glob`;
  text/code location→`grep`; symbol body/relation→`code_graph`;
  known file/span→`read`
  directly without `grep`; verified directory→`list`; known
  edit→`apply_patch`; program/state change→`shell`; web/current external
  info→`search`.
- Shortest total calls, maximum batching — every turn: every determined call
  in one concurrent message (mix `shell` in), merged per tool — one `shell`
  chain, one `read`, one `apply_patch` carrying full verification in
  `post_shell`; a later turn only for steps needing unseen output.
- Verified paths: project root, session cwd, user-provided, tool-returned.
  `find` first for guessed path/name fragments; on ENOENT, find the basename.
  Retry `EXPLORATION_FAILED` once with changed tokens.
- Stop when evidence covers the deliverable: a returned `path:line` or
  nonzero `content_with_context` result is final — act on it (inspecting it
  via read/code_graph is valid); only zero/error results justify changed
  tokens or scope. Don't re-locate, re-verify, or reread returned spans.
- Verify changes in proportion to risk with one decisive batched boundary
  probe. A pass is final; on failure, fix and rerun only what failed. Keep
  optional diagnostics non-fatal; report verified vs assumed.
- `apply_patch` is the primary edit tool: once target path and new content are
  known, include the patch in the current tool batch, hunk context verbatim
  from the newest tool output of that span (post-patch content after edits).
- After starting or receiving a background task, end the turn — its
  completion notification resumes the work. Never poll, sleep-loop, or block;
  explicit wait only for a result the current turn cannot proceed without.
  Long commands whose output the next step does not need go async.
