# Exploration

- Use non-mutating readers directly. For stateful inputs, keep an unchanged
  backup of every source artifact and work on a separate copy; take the backup
  inside the first inspection call, never as a separate step. Keep it after
  replacing originals unless the user requires purging. Allocate temp
  workspaces with a unique-directory allocator; never clear existing paths or
  mutate to bypass unexpected state.
- UI/edit sites: use `grep` to locate unknown regions. If locations are
  already known, read only missing ranges directly and batch independent
  ranges. Reconnaissance returns locations (`context:0`, `mode:files`); fetch
  content only for ranges you will edit or verify. Never combine `overview`
  and `symbols` for one need. Prior sessions need a request or open decision.
- Supplied/home/environment paths need no locator; project-relative inside,
  explicit outside; one parent listing, not sibling walks.
- Sample each unknown format once, not every file of a known structure; list
  paths only when the list itself is needed. Read one sample before writing
  parsing or counting logic over unknown data — the observed format decides
  the parser; then process full data programmatically. A sample is not the
  input domain. Inspect large or binary data through bounded slices (head,
  offset windows, aggregates); never dump whole files, hex, or per-item
  listings into a result.
