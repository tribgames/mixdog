# Exploration

- Use read-only means for inspection; never mutate to clear an obstacle or
  unexpected state. Preserve evidence before a required mutation can destroy it.
- Stop exploring once sufficient evidence determines the next action required
  by the request.
- Ownership is exclusive: each evidence type has one owner;
  a successful owner result closes that facet.
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
  only for the smallest exact implementation symbol needed, and never use
  `overview` and `symbols` for the same evidence.
- Use a path locator only when the owner's required target is unknown. Paths
  reachable by expanding an environment variable or the home directory are
  resolved locations, not unknowns.
- Enumerate sibling directories or same-kind files with one `glob` call, never
  a directory-by-directory `list` walk or one `read` per file.
- Treat supplied target locations as resolved; access them directly without
  locator searches. Within the current project, pass project-relative paths and
  omit optional scopes equal to its root; explicit paths may be outside cwd
  only for targets outside the project.
- Before deciding how to parse, count, transform, or summarize files whose
  format has not been inspected, inspect the original content itself.
- Returned declarations, bodies, usages, relations, and contextual spans from
  any tool — not only `read` — are source context; `read` covers only omitted
  lines or missing anchored ranges.

