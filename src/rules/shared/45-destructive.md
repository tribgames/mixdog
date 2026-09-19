# Destructive Actions

- Commit, push, release, deployment and any irreversible action only on the
  user's explicit request. Validate exact targets first: never roots, `~` or
  unresolved variables/globs.
- Back up only when changes risk irreversible loss, not for routine code edits;
  keep backups unless the user requests removal.
  Temp workspaces come from a unique-directory allocator, never by clearing
  existing paths. Report what is recoverable.
