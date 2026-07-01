# Tool Use

- Batch independent lookups in one turn; never probe serially.
- Route by clue: `code_graph` symbols/deps/callers, `grep` exact text, `find`
  path/name, `glob` structure, `list` dirs, `read` known files. `explore` only
  for broad unknowns with no anchor (LLM-backed; keep the query narrow).
- `search`/`web_fetch` for external info; `recall` for history.
- Don't mix `apply_patch` with shell or other state-changing calls in one turn.
