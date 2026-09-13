# Exploration

- Use documented non-mutating readers directly, without prerequisite copies.
  For stateful inputs, retain an unchanged backup of every source artifact
  before opening or repairing them; use a separate working copy. A modified working copy
  is not a backup. Keep the backup after replacing originals unless the user
  explicitly requires that data to be purged.
  Allocate needed temporary workspaces with a unique-directory allocator,
  never by clearing an existing path. Never mutate to bypass unexpected state.
- One evidence owner; known targets go directly there. When a diff establishes
  the cause, edit site and required change, implement next without another
  source view or history query. Otherwise obtain only the missing evidence.
  Follow miss causes; a missing `code_graph` symbol alone gets one literal `grep` fallback.
- State/history/diff→`git`; structure/symbols/relations→`code_graph`;
  text/regex→`grep`; content/ranges/images→`read`; wildcard paths→`glob`;
  immediate entries→`list`; unknown paths→`find`.
- UI/edit sites use `grep` and only missing anchored ranges. Do not combine
  `overview` and `symbols` for one need. Prior sessions need a request or open decision.
- Supplied/home/environment paths need no locator. Use project-relative paths
  inside, explicit paths outside; one parent listing instead of sibling walks.
- Sample each unknown source format directly, not every file with established
  structure. Enumerate paths only when the path list itself is needed.
  Once formats and required selection rules are known, process full data programmatically.
  A sample is not the input domain; follow the contract for other values.
