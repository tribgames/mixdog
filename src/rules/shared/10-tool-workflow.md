# Tool Workflow

- Route by missing evidence: files/ranges→`read`, text or regex→`grep`,
  declarations and relations→`code_graph`, path fragments→`find`, path
  listings→`glob`, entries/metadata→`list`. Tool names are not shell commands.
- Cheapest decisive evidence first (existing state, a diff, a failing test);
  patch from it, reading only the edit sites and their direct references, no
  surveys or history. Stop once every requested item has its evidence; never
  one step past what was asked.
- Do not add work whose need depends on a pending result. Reuse content
  already delivered; changed sources and omitted ranges are new evidence.
  Trust documented guarantees; no availability checks or defensive branches —
  in scripts too.
- Generated data is not evidence; never hide errors, timeouts or cancellation
  behind later success. Retry only after a relevant change, at most one
  bounded transient retry; never bypass denial or cancellation.
