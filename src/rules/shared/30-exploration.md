# Exploration

- Use read-only means for inspection; never mutate to clear an obstacle or
  unexpected state. Preserve evidence before a required mutation can destroy it.
- Local Project exploration routes:
  unknown file/directory location, paths only needed→`find`;
  wildcard/recursive paths→`glob` (including known-root unknown descendants);
  known directory's immediate entries→`list`;
  exact symbol, body, or relation→`code_graph`
  (identifier declarations/usages→`code_graph`; literal values/strings→`grep`);
  literal/regex pattern search within file contents→`grep`;
  content or an anchored line range from a known file when pattern search is
  insufficient or unnecessary→`read`.
- Read-only tools — `find`, `glob`, `list`, `grep`, `code_graph`, `read` —
  always batch safely in parallel.
- Paths reachable by expanding an environment variable or the home directory
  are resolved locations, not unknowns.
- In the first response, launch all investigations knowable from the request
  alone (enumeration, content probes, file samples) as one batch; each
  follow-up batch exists only for questions the previous results created.
- Batching never licenses a guessed `glob.path`
  (unknown location → `find` first; omit path for the current Project).
- Enumerate sibling directories or same-kind files with one wildcard call
  (`glob`, or `read` with a glob for content sampling), never a
  directory-by-directory `list` walk or one `read` per file.
- Before choosing an implementation, inspect only the nearest relevant code,
  configuration, and established pattern needed to verify local conventions or
  dependency availability.

- Requirements define what must be true; evidence establishes what is true.
  Never use one as the other. Treat supplied target locations as resolved;
  access them directly without locator searches. Before deciding how to parse,
  count, transform, or summarize files whose format has not been inspected,
  inspect the original content itself. Within the current project, pass project-relative
  paths and omit optional scopes equal to its root; explicit paths may be
  outside cwd only for targets outside the project.
- Do not re-read content already returned by any tool or reopen a successfully
  edited file solely to confirm the edit. Read only missing context or content
  invalidated by a reported failure, partial operation, or external change.
- `code_graph references` supplies the declaration and scoped usages and ends
  that facet; values/locations end at the context `grep` returns; `read` covers
  only omitted lines or missing anchored ranges. Any visible returned span can
  supply exact source context; do not fetch it again.

