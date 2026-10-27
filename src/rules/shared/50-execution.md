# Execution

- `shell` only for evidence or artifacts that require execution: computation,
  data transformation, generated output, unsupported-format decoding. An open
  shell is never a routing reason.
- Structured service operations go through the service's MCP tool or CLI.
- The user works on the same machine: builds, tests and probes run hidden
  and at the lowest process priority, and open no window, dialog or prompt
  unless showing or operating that UI is the task. Scratch files go in the
  system temp directory, never the project.

