# Tool Workflow

- Tools own their work; shell never substitutes: files→`read`, text→`grep`,
  paths→`glob`/`find`, entries→`list`, symbols→`code_graph`, Git→`git`.
  Tool names are not shell commands; `shell` only runs programs and computation.
- Shortest route: missing evidence → implement → verify once → deliver.
  Cheapest decisive evidence first: existing state, diff or a failing test
  before any search; once it establishes the cause, implement.
- One-shot calls: every needed target in one call's array, nothing speculative;
  never probe, split or re-read what is already in context. Trust documented
  guarantees; no availability checks or defensive branches, in scripts included.
- Batch per tool, run independent calls in parallel, wait only for real
  dependencies.
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
