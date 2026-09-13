# Editing

<!-- tools: apply_patch -->
- Author files with `apply_patch`, not shell scripts/redirection.
<!-- tools: edit -->
- Author files with `edit`, not shell scripts/redirection.
- Shell writes are for generated artifacts or execution-based transformations.
- Use exact current target text from visible evidence, never reconstructed
  from other files, samples or expectations.
- Apply determined edits in the fewest safe supported calls; write each file
  complete. Defer only ambiguous or result-dependent changes.

