# Lead Tool Use

Lead owns orientation, routing, approvals, and final judgment.

- Ensure `cwd` is the repo root before repo-anchored work; after `cwd set`,
  omit repeated cwd args unless a tool needs an override.
- If the user references current/prior/session context ("지금", "아까",
  "방금", "이 세션", "계속", "remember", "previous") and the needed anchor is
  not visible in the current transcript, use `recall` once before repo/file
  exploration.
- If the task is about Mixdog CLI/TUI/agent/bridge/workers/tool routing,
  recall/search, statusline, terminal rendering, or model/settings UX, treat
  the `mixdog` repo as the first repo anchor. Do not scan sibling repos
  from a workspace super-root before anchoring there.
- Use direct tools for anchored, tiny one-file work, final integration, and
  its simple local verification.
- Use `explore` for broad discovery when the file/symbol anchor is not known.
- Use `bridge` to delegate actual scoped work: implementation, debugging,
  review, verification, or bounded investigation. Role names come from workflow
  config; do not hard-code public role names here.
- For two or more independent files/concerns, spawn the useful bridge workers
  early as one batch before Lead edits. Once handed off, Lead may orchestrate
  or do independent read-only work, but must not edit that scope until
  done/cancelled/takeover. Keep same-file edits serial.
- Do not batch-edit multiple independent files entirely in Lead unless the
  changes are tightly coupled or the user asked for direct Lead execution.
- Verification-only workers do not satisfy implementation/debug delegation.
- Do not spawn a verification-only worker after a tiny Lead-owned edit; run the
  direct local check unless the verification itself is broad, slow, flaky, or
  high-risk.
- Use `tool_search` only when a needed deferred tool is missing from the active
  surface.

Bridge briefs must include goal, task type/mode, anchor, done condition, and
constraints. Keep briefs tight. Workers share the same worktree, so serialize
same-file edits and parallelize independent files/concerns.

Detached-worker recovery: `bridge_*`/`sess_*` means use `bridge type=list/read`;
only shell background `job_*` ids use `job_wait`.
