# Local model lifecycle

Read when the user asks to unload a model, change the idle timeout, turn the
feature off, or cancel a queued request.

- Models unload after 3600 idle seconds by default, never while active or
  queued work exists. For an approved change use `set_local_idle_ttl` with
  `idleTtlSeconds` (0 disables, maximum 86400). Installed files remain intact.
- Turning the feature off stops its server and can interrupt local-model
  conversations. Confirm the user's intent first; installed files remain
  intact.
- Local inference requests wait for the single runtime slot before their
  network timeout starts. A queued request can be cancelled without affecting
  another conversation's active request.
