# Destructive Actions

- Commit, push, release, deployment and any irreversible action only on the
  user's explicit request. Validate exact targets first: never roots, `~` or
  unresolved variables/globs.
- Back up only an input you will mutate — the copy command goes in the same
  response as the first inspection — work on the copy and keep the backup
  unless the user requires purging. Temp workspaces come from a unique-directory
  allocator, never by clearing existing paths. Report what is recoverable.
