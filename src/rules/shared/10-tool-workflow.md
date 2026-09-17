# Tool Workflow

- Route by missing evidence: files/ranges→`read`, text or regex→`grep`,
  declarations and relations→`code_graph`, path fragments→`find`, path
  listings→`glob`, entries/metadata→`list`, Git→`git`; `shell` only runs
  programs and computation. Tool names are not shell commands.
- Shortest route: cheapest decisive evidence first (existing state, a diff, a
  failing test), then implement from it — a diff, a failing assertion or an
  error location is patched directly; read only the exact edit sites and their
  direct references, no surveys or history. Stop once every requested item has
  its evidence; never follow a chain one level past what was asked.
- Do not add work whose need depends on a pending result. Reuse content
  already delivered; changed sources and omitted ranges are new evidence.
  Trust documented guarantees; no availability checks or defensive branches,
  in scripts included.
- Validate exact targets before destructive actions; never roots, `~` or
  unresolved variables/globs. Report deletion recoverability.
- Generated data is not evidence; never hide errors, timeouts or cancellation
  behind later success. Retry only after a relevant change, at most one
  bounded transient retry; never bypass denial or cancellation.
<!-- tools: load_tool -->
- `load_tool` only for unknown deferred schemas.
