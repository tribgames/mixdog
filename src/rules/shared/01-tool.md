# Tool Use

- Run independent tool calls in the same turn. Start source lookup with one
  compact combined batch, not serial probes.
- Route by clue: `explore` broad unknowns, `code_graph` symbols/deps/callers,
  `grep` exact text, `find` path/name clues, `glob` structure, `list` dirs,
  `read` known file windows.
- Prefer exact local repo tools (`grep` / `find` / `glob` / `code_graph`) for
  clear path, symbol, or text anchors. For genuinely broad/uncertain source
  discovery, `explore` may be included in the initial compact lookup batch; keep
  its query narrow because it is LLM-backed.
- Use available `search` / `web_fetch` only for web/current external info;
  available `recall` only for history.
- Fan out read-only lookup calls. Batch known independent files with `read`.
- For read-only locator/review-scoping tasks, stop after the first compact
  lookup/read batch that yields credible anchors. Do not run extra verification
  probes unless the anchors conflict or are missing.
- If editing is available, put related multi-file edits in one `apply_patch`.
  Do not run state-changing edits or shell alongside other tool calls.
- `shell` only CHANGES state or RUNS programs (git/build/test/run). Inspecting
  the filesystem — read, list, search, existence — always goes through the
  dedicated tools, never a shell command.
