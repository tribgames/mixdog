# Tool Use

- When multiple tool calls are independent, run them in the same tool turn.
- For source lookup, use `find` for partial file/path clues, `glob` for known
  patterns, `grep` for exact text, `list` for directories, and `read` for known
  paths. Keep `code_graph` for structural, symbol, or dependency questions.
- Fan out independent read-only lookup calls when useful. Use `read` path
  arrays for known independent files.
- Put related multi-file edits in one `apply_patch` call. Do not run
  state-changing edits or shell commands in parallel.
- Use `shell` for git, build, test, run, and verification commands, not for
  ordinary source browsing.
