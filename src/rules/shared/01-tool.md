# Tool Use

- Run independent tool calls in the same turn. Start source lookup with one
  compact parallel batch, not serial probes.
- Route by clue: `explore` broad unknowns, `code_graph` symbols/deps/callers,
  `grep` exact text, `find` path/name clues, `glob` structure, `list` dirs,
  `read` known file windows.
- Use available `explore` for broad/uncertain repo anchors; narrow queries.
- Use available `search` / `web_fetch` only for web/current external info;
  available `recall` only for history.
- Fan out read-only lookup calls. Batch known independent files with `read`.
- If editing is available, put related multi-file edits in one `apply_patch`.
  Do not parallelize state-changing edits or shell.
- Use available `shell` only for git/build/test/run/verification, not browsing.
