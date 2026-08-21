# Editing

<!-- tools: apply_patch -->
- A required new file is created directly: Add File is itself the atomic
  absence check, so inspect only if it reports the target already exists.
<!-- tools: edit -->
- A required new file is created directly: an empty `old_string` is itself the
  atomic absence check, so inspect only if it reports the target already exists.
- Source: use exact current target text from any visible evidence, including
  user input, tool output, or an applied edit result; never reconstruct it from
  another file, a sample, or expectation.
<!-- tools: edit -->
- Placement: use an exact unique target string, expanding exact surrounding
  text when needed.
<!-- tools: apply_patch -->
- Placement: use exact unchanged context and add a class/function locator when
  context alone is not unique.
- Apply all determined changes in the fewest safe calls the active tool
  supports; a file written in one call is written complete.
<!-- tools: apply_patch -->
- One file, several changes: one Update File block carries every hunk.
<!-- tools: edit -->
- One file, several changes: issue the calls together in one turn — they apply
  in call order — while no target overlaps another and none depends on text an
  earlier call creates. Widening one target across the gap is equivalent only
  while every spanned line stays verbatim.
- Defer only ambiguous or result-dependent changes.

