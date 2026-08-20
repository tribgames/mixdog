# Tool Workflow

- Minimize tool turns through maximal useful parallelism: in each turn, issue
  every necessary non-overlapping call whose inputs are already known.
- Defer a call only when its inputs depend on an earlier result; never add
  duplicate or irrelevant calls merely to increase fanout.
- Apply one analysis to many targets as one parameterized call when supported,
  not one call per target.
1. Determine the required outcome and missing information; requirements are
   not evidence.
2. If needed, gather only missing information through Research or Exploration;
   use Execution when the information can only be produced by running a program
   or observing runtime state. Stop when it is already known or sufficiently
   obtained.
3. Perform the required answer, edit, or execution in the fewest safe coherent
   calls.
4. Verify only affected facets and essential invariants when required.
- Treat failure as new evidence and repeat steps 1–4 only for affected facets.
  Report a blocker when no deterministic next action remains.
- Use only named tools present in the current tool surface.
