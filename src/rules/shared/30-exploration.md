# Exploration

- Use non-mutating readers directly. For stateful inputs, keep an unchanged
  backup of every source artifact and work on a separate copy; take the backup
  inside the first inspection call, never as a separate step. Keep it after
  replacing originals unless the user requires purging. Allocate temp
  workspaces with a unique-directory allocator; never clear existing paths or
  mutate to bypass unexpected state.
- UI/edit sites: use `grep` to locate unknown regions. If locations are
  already known, read only missing ranges directly and batch independent
  ranges. Never combine `overview` and `symbols` for one need. Prior sessions
  need a request or open decision.
- Supplied/home/environment paths need no locator; project-relative inside,
  explicit outside; one parent listing, not sibling walks.
- Sample each unknown format once, not every file of a known structure; list
  paths only when the list itself is needed; then process full data
  programmatically. A sample is not the input domain.
