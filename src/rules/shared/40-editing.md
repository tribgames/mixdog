# Editing

<!-- tools: apply_patch -->
- Use `apply_patch` for authored file creation and source edits, not shell scripts
  or redirection.
<!-- tools: edit -->
- Use `edit` for authored file creation and source edits, not shell scripts
  or redirection.
- Shell writes are for generated artifacts or transformations requiring execution.

<!-- tools: apply_patch -->
- A required new file is created directly: Add File is itself the atomic
  absence check, so inspect only if it reports the target already exists.
<!-- tools: edit -->
- With `edit`, empty `old_string` creates a missing file or fills an empty
  file; it is not an absence check and never overwrites a non-empty file.
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

