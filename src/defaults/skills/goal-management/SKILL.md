---
name: goal-management
description: Manage durable goals, task progress, approvals, and completion.
when_to_use: 'Explicit durable-goal requests or managing existing Goals; not ordinary task planning or complexity.'
dependencies:
  tools:
    - type: tool
      value: goal
---

# Goal management

Use `goal` to maintain durable tasks and their idle reminders. The tool schema
owns arguments and limits; this guide owns the lifecycle and completion policy.

## Admission and current state

Create a Goal only on an explicit user or system/developer request. Ordinary
tasks, complexity, and planning needs do not imply that request. If work needs
approval, obtain it before creation. An existing Goal does not authorize new scope.

Use the latest returned state and revision. If unknown or stale, read `status`
and reconcile before mutating. Never replay a stale mutation blindly.
Create with the full approved task list and verification outcomes.

## Maintain progress

- Capture new requirements immediately. Mark work `in_progress` before starting
  and `completed` as soon as fully done; update changed plans before continuing
  or reporting. Drop a task only after the user changes its scope.
- Prefer `update_tasks` for changed items; `set_tasks` replaces the full list.
  Serialize mutations to the same Goal. `resume` accepts updates and additions
  atomically. Starting work also resumes a paused Goal; bookkeeping alone does not.
- Batch updates with independent work when possible, but never delay an update
  just to batch it. Creation, status, and resume return full state; other
  successful replies are brief and need no confirmation read.

## Approval and waiting

Finish every approved step. Record additions immediately, but park new work
requiring approval and anything its answer could invalidate as
`awaiting_approval`. Continue unaffected approved work.

`paused` is the only user-wait state. Pause only when nothing else can proceed,
ask all parked questions together, and resume alongside resumed work. Routine
errors and retries are not reasons to pause.

## Completion and recovery

Complete only after auditing every user condition against evidence. A requested
duration commits the full period; only explicit user completion can end it early.
Do not end a Goal merely because a partial result is available.

Use `block` only when the same external impasse has stopped progress for three
consecutive turns, never for user input or direction. Use `abandon` only when
the user redirects away from the objective.

Done when the returned Goal state accurately represents completed work,
remaining approved work, or the justified waiting/terminal condition.
