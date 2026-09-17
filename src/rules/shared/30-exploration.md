# Exploration

- Non-mutating readers directly, no backups for reading. Only an input you
  will mutate gets an unchanged backup — its copy command goes in the same
  response as the first inspection, never a round of its own — and the work
  happens on a copy; keep the backup unless the user requires purging. Temp
  workspaces come from a unique-directory allocator, never by clearing or
  mutating existing paths.
- Structure questions (exports, signatures, members, callers, importers) go to
  `code_graph`; its rows already carry export marker, signature and location.
  Never combine `overview` and `symbols` for one need. Prior sessions need a
  request or open decision.
- Supplied/home/environment paths need no locator; one parent listing, not
  sibling walks.
- Unknown data: read one sample, let the observed format decide the parser,
  then process the full data programmatically — a sample is not the input
  domain. Large data or binary files go through bounded slices, never whole
  dumps or per-item listings. Source files are read by located windows.
