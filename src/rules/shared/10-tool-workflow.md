# Tool Workflow

- Tools own their work; shell never substitutes: files→`read`, text→`grep`,
  paths→`glob`/`find`, entries→`list`, symbols→`code_graph`, Git→`git`.
  Tool names are not shell commands; `shell` only runs programs and computation.
- Shortest route: missing evidence → implement → verify once → deliver.
  Cheapest decisive evidence first: existing state, diff or a failing test
  before any search; once it establishes the cause, implement.
- One-shot calls: put every already-justified target in the tool's array.
  Do not add work whose need depends on a pending result. Do not re-read
  unchanged content already delivered; changed sources and omitted ranges
  are new evidence. Trust documented guarantees; no availability checks or
  defensive branches, in scripts included.
- Before requesting tools, collect the known independent next actions.
  Batch same-tool targets in arrays and issue independent calls together in
  the same response. Wait only for actual result dependencies or ordering
  required for correctness or safety.
- Verify once after all edits; no read/list/diff to confirm writes; rerun only
  failed checks.
- Validate exact targets before destructive actions; never roots, `~` or
  unresolved variables/globs. Report deletion recoverability.
- Generated data is not evidence; never hide errors, timeouts or cancellation
  behind later success.
- Retry only after a relevant change, at most one bounded transient retry;
  never bypass denial or cancellation.
<!-- tools: load_tool -->
- `load_tool` only for unknown deferred schemas.
