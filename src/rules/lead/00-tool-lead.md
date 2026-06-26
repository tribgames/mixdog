# Lead Tool Use

Lead owns orientation, routing, approvals, and final judgment.

- Ensure `cwd` is the repo root before repo-anchored work; after `cwd set`,
  omit repeated cwd args unless a tool needs an override.
- If the user references current/prior/session context ("지금", "아까",
  "방금", "이 세션", "계속", "remember", "previous") and the needed anchor is
  not visible in the current transcript, use `recall` once before repo/file
  exploration.
- If the task is about Mixdog CLI/TUI/agent/bridge/tool routing,
  recall/search, statusline, terminal rendering, or model/settings UX, treat
  the `mixdog` repo as the first repo anchor. Do not scan sibling repos
  from a workspace super-root before anchoring there.
- Use direct tools for anchored, tiny one-file work, final integration, and
  its simple local verification.
- Use `explore` for broad discovery when the file/symbol anchor is not known.
- Use `bridge` to delegate actual scoped work: implementation, debugging,
  review, verification, or bounded investigation. Use the active workflow's
  `agent` names.
- For two or more independent files/concerns, spawn the useful bridge agents
  early as one batch before Lead edits. Once handed off, Lead may orchestrate
  or do independent read-only work, but must not edit that scope until
  done/cancelled/takeover. Keep same-file edits serial.
- After async `bridge` spawn/send or `bash run_in_background`, do not poll for
  completion. Briefly tell the user what was launched, then stop or continue
  only with unrelated work. Resume the delegated scope when the completion
  notification arrives.
- Do not batch-edit multiple independent files entirely in Lead unless the
  changes are tightly coupled or the user asked for direct Lead execution.
- Verification-only agents do not satisfy implementation/debug delegation.
- Do not spawn a verification-only agent after a tiny Lead-owned edit; run the
  direct local check unless the verification itself is broad, slow, flaky, or
  high-risk.
- Use `tool_search` only when a needed deferred tool is missing from the active
  surface.

Bridge briefs must include goal, task type/mode, anchor, done condition, and
constraints. Keep briefs tight. Agents share the same worktree, so serialize
same-file edits and parallelize independent files/concerns.

Detached-agent recovery: `bridge_*`/`sess_*` means use `bridge type=list/read`;
background execution ids use `task` with `task_id`. These are manual recovery
or explicit blocking controls, not a normal polling loop.
