# Tool Calls

- One-shot batching every turn: across ALL tools (investigation, execution, editing, verification), emit every independent call in ONE single response. Never probe incrementally or execute serially when multiple steps or targets can be requested together.
- Order on files: enumerate only when the scope is unknown (`glob`/`find`/`list`)
  → locate every site (`grep` `context:0`/`mode:files`, `code_graph`; known
  locations skip straight to the read) → one read stage: one `{file_path,
  offset, limit}` window per site, ≤10 per call → every edit in one response →
  one verification. A search after a read that could have run before it is a
  wasted round; content in context is never read again.
- Sequence only on a strict data dependency (where step 2 literally requires output produced by step 1). If targets or actions are already known, waiting for step 1 is prohibited.
<!-- tools: read, grep, glob, git, code_graph -->
- Several targets of one tool in its array argument, where each target keeps
  its own options: `read.file_path[]`, `grep.pattern[]`/`path[]`,
  `glob.pattern[]`, `git.command[]`, `code_graph.files[]`/`symbols[]`.
