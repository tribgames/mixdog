# Tool Calls

- Group calls already known to be needed in one response. Sequence only when
  an earlier operation or result is needed to choose or safely run a later call.
- For `read`, `grep`, `glob`, `git`, and `code_graph`, combine compatible targets
  in one array call; split only for dependencies, differing options or scope,
  or schema limits.
- Order on files: enumerate only when the scope is unknown → locate every
  site (known locations skip straight to the read) → one read stage over every
  located site → every edit in one response → one verification. A search after
  a read that could have run before it is a wasted round.
