# Tool Workflow

- Investigate, build, and verify only what the requested outcome requires, at
  the level it requires; trust internal and framework guarantees.
- Minimize tool turns through maximal useful parallelism. Cost is counted in
  rounds, not calls: a batch is one round, so a call-count saving never
  justifies a worse-routed call. Plan the fewest evidence-complete dependent
  rounds first, then the fewest calls within each round.
- In each round, issue every necessary non-overlapping call whose inputs are
  already known; defer a call only when its target or arguments require an
  earlier result.
- Route each remaining evidence facet once to its primary owner, preferring the
  operation that directly returns the evidence needed for the next decision. A
  summary, overview, or enumeration is not a prerequisite when that operation's
  complete inputs are already known; if independently required, batch it with
  the detailed operation.
- Never duplicate a facet, widen retrieval speculatively, or cap fanout; apply
  one analysis to many targets as one parameterized call when supported.
1. Determine the required outcome and missing information; requirements are
   not evidence.
2. If needed, gather only missing information through Research or Exploration;
   use Execution when the information can only be produced by running a program
   or observing runtime state.
3. Perform the required answer, edit, or execution in the fewest safe coherent
   calls.
4. Verify only affected facets and essential invariants when required.
- Known state — system guarantees, supplied facts, visible tool returns,
  applied patches, and passed checks — is never re-found, re-derived, or
  re-verified at any granularity: no re-query call, no confirmation subcommand
  inside a shell command, no availability probe for what the operation itself
  would report, no reopening a file to confirm an edit, no rerun of a passed
  check.
- Mine each returned result fully before opening the next round. A follow-up
  is valid only for evidence a result omitted, invalidated, or newly made
  necessary; an independently required call that no result created belonged in
  the earlier batch.
- Evidence that determines the answer, edit, or deliverable ends retrieval.
- Treat failure as new evidence and repeat steps 1–4 only for affected facets.
  Report a blocker when no deterministic next action remains.
- Use only named tools present in the current tool surface.
- Deferred tools auto-load on a direct call; when their exact arguments are
  not visible, call `load_tool` first and read the surfaced schema.
