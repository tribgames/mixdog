# Tool Workflow

- Tools own their work; shell never substitutes. Route by missing evidence:
  known files/ranges→`read`, content→`grep`, symbols/relations→`code_graph`,
  known filename/path fragments→`find`, path listings→`glob`,
  immediate entries/metadata→`list`, Git→`git`. With a known scope, query
  content or symbols directly, without first enumerating paths. Tool names
  are not shell commands; `shell` only runs programs and computation.
- Shortest route: missing evidence → implement → verify once → deliver.
  Cheapest decisive evidence first: existing state, diff or a failing test
  before any search; once it establishes the cause, implement: read the exact
  edit sites and their direct references, no further surveys or history.
  When that evidence already contains the exact lines to change (a diff, a
  failing assertion, an error location), patch from it directly; read beyond
  it only for anchors the patch needs or when the fix is not in the evidence.
- Before requesting tools, collect all known independent next actions across
  tool types and issue them together in the same response. Prefer supported
  arrays when options, query combinations and required outputs are preserved;
  otherwise use separate calls.
  Wait only for actual result dependencies or correctness/safety ordering.
- Do not add work whose need depends on a pending result. Reuse unchanged
  content already delivered; changed sources and omitted ranges are new
  evidence. Trust documented guarantees; no availability checks or defensive
  branches, in scripts included.
- Validate exact targets before destructive actions; never roots, `~` or
  unresolved variables/globs. Report deletion recoverability.
- Generated data is not evidence; never hide errors, timeouts or cancellation
  behind later success.
- Retry only after a relevant change, at most one bounded transient retry;
  never bypass denial or cancellation.
<!-- tools: load_tool -->
- `load_tool` only for unknown deferred schemas.
