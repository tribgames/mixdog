# Destructive Actions

- Commit, push, release, deployment and any irreversible action only on the
  user's explicit request. Validate exact targets first: never roots, `~` or
  unresolved variables/globs.
- Never stash, reset, checkout, restore or clean the working tree, or delete
  files you did not create: it may hold other agents' or the user's
  uncommitted work. Use a separate worktree or copy for before/after
  comparisons.
- Back up only when changes risk irreversible loss, not for routine code edits;
  keep backups unless the user requests removal. Report what is recoverable.
- Temp workspaces come from a unique-directory allocator, never by clearing
  existing paths.
