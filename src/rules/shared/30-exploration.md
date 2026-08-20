# Exploration

- Use read-only means for inspection; never mutate to clear an obstacle or
  unexpected state. Preserve evidence before a required mutation can destroy it.
- Local Project exploration routes:
  unknown file/directory location, paths only needed→`find`;
  wildcard/recursive paths→`glob` (including known-root unknown descendants);
  known directory's immediate entries→`list`;
  exact symbol, body, or relation→`code_graph`
  (identifier declarations/usages→`code_graph`; literal values/strings→`grep`);
  file-content search→`grep`;
  known-file content→`read`.
- Paths reachable by expanding an environment variable or the home directory
  are resolved locations, not unknowns.
- In the first response, launch all investigations knowable from the request
  alone (enumeration, content probes, file samples) as one batch; each
  follow-up batch exists only for questions the previous results created, and
  an investigation no result produced belonged in the batch before it.
- Enumerate sibling directories or same-kind files with one wildcard call
  (`glob`, or `read` with a glob for content sampling), never a
  directory-by-directory `list` walk or one `read` per file.

- Treat supplied target locations as resolved;
  access them directly without locator searches. Before deciding how to parse,
  count, transform, or summarize files whose format has not been inspected,
  inspect the original content itself. Within the current project, pass project-relative
  paths and omit optional scopes equal to its root; explicit paths may be
  outside cwd only for targets outside the project.
- Known state — system guarantees, supplied facts, visible tool returns,
  applied patches, and passed checks — is never re-found, re-derived, or
  re-verified at any granularity: no re-query call, no confirmation subcommand
  inside a shell command, no availability probe for what the operation itself
  would report, no reopening a file to confirm an edit, no rerun of a passed
  check. Read only missing context or content invalidated by a reported
  failure, partial operation, or external change.
- Evidence that determines the answer, edit, or deliverable ends retrieval.
- `code_graph references` supplies the declaration and scoped usages and ends
  that facet; values/locations end at the context `grep` returns; `read` covers
  only omitted lines or missing anchored ranges. Any visible returned span can
  supply exact source context.

