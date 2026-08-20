# Editing

- A required new file is created directly: Add File is itself the atomic
  absence check, so inspect only if it reports the target already exists.
- Source: use exact current target text from any visible evidence, including
  user input, tool output, or an applied edit result; never reconstruct it from
  another file, a sample, or expectation.
- Placement: with `edit`, use an exact unique target string, expanding exact
  surrounding text when needed; with `apply_patch`, use exact unchanged context
  and add a class/function locator when context alone is not unique.
- Apply all determined changes in the fewest safe calls the active tool
  supports; a file written in one call is written complete.
- Batch scope: never split one file across concurrent edit calls. Group
  same-intent changes with exact context into coherent calls; issue disjoint
  calls together in one turn, and defer ambiguous or result-dependent changes.

