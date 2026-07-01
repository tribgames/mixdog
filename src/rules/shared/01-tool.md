# Tool Use

- Independent lookups MUST batch in one turn; serialize only when a call needs a prior result.
- Route by clue: symbols/callers/deps → `code_graph`; exact text → `grep`;
  path/name → `find`; structure → `glob`; dirs → `list`; known file → `read`.
- Lookup-heavy tracing: start with one batched `grep` using
  `output_mode:"content_with_context"` (or one `code_graph symbols[]`) to collect
  anchors. Do not sweep the same concept across renamed variants or nearby files.
- On a miss, switch tool once; on a plausible hit, stop searching and answer from
  the framed context. Do not follow `content_with_context` with `read` unless the
  needed span is not shown.
- Avoid read fragmentation: `read` uses `offset`/`limit` only. If you need 2+
  spans from one or more known files, make one batched `read` call with
  `{path,offset,limit}` region objects instead of serial reads.
- `search`/`web_fetch` for external info; `recall` for history.
- Don't mix `apply_patch` with shell or other state-changing calls in one turn.
