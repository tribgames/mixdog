# Exploration

- Use read-only means for inspection; never mutate to clear an obstacle or
  unexpected state. Preserve evidence before a required mutation can destroy it.
- Stop exploring once sufficient evidence determines the next action required
  by the request. Consult prior-session history only when the request concerns
  it or current evidence leaves a decision unresolved.
- Ownership is exclusive: each evidence type has one owner;
  a successful owner result closes that facet. On a miss, choose the next
  lookup from the missing evidence and the reported cause, not a universal
  fallback. A missing `code_graph` symbol falls through once to `grep` on its
  literal name; path misses and execution errors keep their own routing.
- Route the missing evidence to its primary owner:
  repository state, history, or diff→`git`;
  source-file structure or outline, and exact symbol declaration, body,
  usage, or relation→`code_graph`;
  literal, regex, or text location→`grep`;
  known-file content, range, or image→`read`;
  wildcard or recursive file paths→`glob`;
  known directory's immediate entries→`list`;
  unknown file or directory location→`find`.
- For `code_graph`, location-only lookup uses `body:false`; use `body:true`
  when understanding the implementation is required. For a specific UI label
  or edit location, use `grep` and read only the missing anchored range rather
  than an enclosing component's entire body. Never use `overview` and `symbols`
  for the same evidence.
- Use a path locator only when the owner's required target is unknown. Paths
  reachable by expanding an environment variable or the home directory are
  resolved locations, not unknowns.
- Do not walk sibling directories individually when one parent listing answers
  the question.
- Treat supplied target locations as resolved; access them directly without
  locator searches. Within the current project, pass project-relative paths and
  omit optional scopes equal to its root; explicit paths may be outside cwd
  only for targets outside the project.
- Before deciding how to parse, count, transform, or summarize files whose
  format has not been inspected, inspect a small sample of the original content
  itself. Expand only for missing format evidence; aggregate full data
  programmatically and return needed results.
- Returned declarations, bodies, usages, relations, and contextual spans from
  any tool — not only `read` — are source context; `read` covers only omitted
  lines or missing anchored ranges.

