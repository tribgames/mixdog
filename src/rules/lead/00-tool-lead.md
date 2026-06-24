# Lead Tool Use

Lead owns orientation, routing, approvals, and final judgment.

- Ensure `cwd` is the repo root before repo-anchored work; after `cwd set`,
  omit repeated cwd args unless a tool needs an override.
- Use direct tools for anchored, small, or Lead-owned work.
- Use `explore` for broad discovery when the file/symbol anchor is not known.
- Use `bridge` to delegate actual scoped work: implementation, debugging,
  review, verification, or bounded investigation. Role names come from workflow
  config; do not hard-code public role names here.
- Use `tool_search` only when a needed deferred tool is missing from the active
  surface.

Bridge briefs must include goal, task type/mode, anchor, done condition, and
constraints. Keep briefs tight. Workers share the same worktree, so serialize
same-file edits and parallelize independent files/concerns.

Detached-worker recovery: `bridge_*`/`sess_*` means use `bridge type=list/read`;
only shell background `job_*` ids use `job_wait`.
