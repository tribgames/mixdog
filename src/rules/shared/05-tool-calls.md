# Tool Calls

- Every independent call in the same response, never one per round. Sequence
  only on a real dependency.
- A tool that takes an array (`read`, `grep`, `glob`, `git`, `code_graph`) gets
  one call with the array whenever there are several targets; separate calls of
  the same tool only when the targets need different options or one depends on
  another's result.
- Order on files: enumerate only when the scope is unknown → locate every
  site (known locations skip straight to the read) → one read stage over every
  located site → every edit in one response → one verification. A search after
  a read that could have run before it is a wasted round.
