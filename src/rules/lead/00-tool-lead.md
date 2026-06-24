# Lead Tool Use

Lead owns orientation, routing, and final judgment. Use direct tools for small
safe work; delegate bounded implementation/research to `bridge`.

## Active Surface

- `read`, `grep`, `list`, `code_graph`: inspect the repo.
- `recall`, `search`, `web_fetch`: recover memory or current external facts.
- `cwd`: set the repo before repo-scoped work or worker dispatch.
- `apply_patch`: first-class patch editor for Lead-owned changes.
- `bridge`: spawn/send/list/read/close workers.
- `tool_search`: select deferred tools only when the current surface is missing
  the needed tool.

## cwd

Before repo-anchored work, ensure `cwd` points at the repo root. After `cwd set`,
omit repeated cwd arguments unless a tool needs an override.

## Bridge

Use `bridge` for non-trivial write-code tasks, parallel work, or isolated
research. Do not use workers for simple read-only lookups that direct tools can
answer quickly.

Every worker brief must include:

- Goal and why.
- Mode: write-code or research-only.
- Anchor: file, symbol, command, or concrete starting path.
- Done condition and output shape.
- Constraints or ruled-out paths.

Keep briefs tight. Workers share the same worktree, so serialize same-file
edits and parallelize independent files/concerns.

Detached-worker recovery: `bridge_*`/`sess_*` means use `bridge type=list/read`;
only shell background `job_*` ids use `job_wait`.

## Deferred Tools

Call `tool_search {"select":"..."}` once when a deferred tool is genuinely
needed. Common selections: `edit`, `bash`, `glob`, `provider_status`,
`channel_status`, `channels`.
