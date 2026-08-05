# Tool Use

- Before the first call, gather every known facet — environment, capability,
  artifact, failure checks — in one bounded tool message, one shortest route
  per facet: broad/uncertain→`explore` (roles without it: `find`); known
  name fragment→`find`; verified root+wildcard→`glob`; text/code→`grep`;
  symbol body/relation→`code_graph`; known file/span→`read`, not `grep`;
  verified directory→`list`; known edit→`apply_patch`; program/state
  change→`shell`; web/current info→`search`.
- A turn is a plan, not a step: batch to the maximum the plan allows — every
  already-required call rides one concurrent message, merged per tool: one
  `shell` chain (`&&`/`;`), one `read`, one `apply_patch` with the whole edit
  set. Each facet keeps its single route, dedicated tools carry observation,
  and `shell` joins when the plan already needs a program/state change or a
  check. In-message order is guaranteed, so an edit set and its check ride one
  message and a new turn starts at a true data dependency.
- Verified paths: project root, session cwd, user-provided, tool-returned.
  `find` first for guessed path/name fragments; on ENOENT, find the basename.
  Retry `EXPLORATION_FAILED` once with changed tokens.
- Stop when evidence covers the deliverable: a returned `path:line` or
  nonzero `content_with_context` result is final for its returned range. Read
  is allowed for new/uncovered lines; do not call read when grep/read already
  fully covers the requested range. Only zero/error results justify new scope.
- Close the edit set with its own proof: the `apply_patch` that finishes it
  carries the check in `post_shell` (or a `shell` tail in the same message) —
  one probe for the whole set, sized to the risk it introduces. Probe where the
  change can actually fail; report a low-risk edit as done on the patch result
  alone. Observed matching output IS the verification — carry it forward as
  settled; on failure fix and rerun what failed. Optional diagnostics
  non-fatal; report verified vs assumed.
- `apply_patch` is the primary edit tool: use it once target path and new
  content are known, hunk context verbatim from the newest tool output of that
  span (post-patch content after edits).
- After starting or receiving a background task, end the turn — its
  completion notification resumes the work. Never poll, sleep-loop, or block;
  explicit wait only for a result the current turn cannot proceed without.
  Long commands whose output the next step does not need go async.
