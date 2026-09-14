# Editing

<!-- tools: apply_patch -->
- Author files with `apply_patch`, never shell scripts or redirection.
<!-- tools: edit -->
- Author files with `edit`, never shell scripts or redirection.
- Shell writes only for generated artifacts or execution-based transformations.
- Target text comes from visible evidence, never reconstructed.
- Fewest safe calls; write each file complete; defer only result-dependent changes.

