# Tool Calls

- Issue every call you already know you need in one response, compatible
  `read`, `grep`, `glob`, `git` and `code_graph` targets as one array call.
  Sequence or split only when a later call depends on an earlier result, or
  options, scope or schema limits differ.
- Order on files: enumerate only when the scope is unknown → locate every
  site (known locations skip straight to the read) → one read stage over every
  located site → every edit in one response → one verification. Search again
  only for what a read newly revealed.
