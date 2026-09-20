# Tool Calls

- Order on files: enumerate only when the scope is unknown (`glob`/`find`/`list`)
  → locate every site (`grep` `context:0`/`mode:files`, `code_graph`; known
  locations skip straight to the read) → one read stage over every located
  site → every edit in one response → one verification. A search after a read
  that could have run before it is a wasted round; content in context is never
  read again.
- Every independent call in the same response, never one per round. Sequence
  only on a real dependency.
- A tool that takes an array gets one call with the array whenever there are
  several targets; separate calls of the same tool only when the targets need
  different options or one depends on another's result.
