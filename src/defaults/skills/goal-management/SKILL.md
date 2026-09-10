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
For multi-step work, record the approved milestones and keep them durable.
One-step work does not need a ceremonial plan or a separate verification row.

## Maintain progress

- Update tasks at meaningful milestones and scope changes. Preserve unfinished
  requirements; drop a task only after the user changes its scope.
- Prefer `update_tasks` for changed items; `set_tasks` replaces the full list.
  Serialize mutations to the same Goal. `resume` accepts updates and additions
  atomically. Starting approved work can resume a user-answer wait, never a
  user-initiated pause. Bookkeeping alone does not authorize execution.
- Batch related task changes and independent work. Creation, status, and resume return full state; other
  successful replies are brief and need no confirmation read.

## Approval and waiting

Finish every approved step. Record additions immediately, but park new work
requiring approval and anything its answer could invalidate as
`awaiting_approval`. Continue unaffected approved work.

Pause only when all remaining tasks await a user answer. Include the required
answer as `blocker` and ask the parked questions together. Do not pause merely
because clarification would help. Respect a user-initiated pause until the user
asks to continue; routine errors and retries are not reasons to pause.

Each continuation should do concrete work or wait on a verified live handle.
Evidence that changes the next action is progress; repeated reports and plan
updates alone are not. Reassess a no-progress turn and take the next safe action.
Observation timeouts do not terminate the observed work or justify restarting it.

## Completion and recovery

Complete only after auditing every user condition against evidence. Reuse valid
checks; a separate verification task is optional, verification itself is not.
A maximum time budget allows verified early completion. Only an explicitly
requested sustained duration commits the full period. Preserve an existing
Goal's time mode; never extend its budget or change its meaning on your own.
Do not end a Goal merely because a partial result is available.

Report a genuine external impasse with `block` once per turn, with a stable
description of the same condition. The runtime stops after three consecutive
turns confirm it; until then continue any available work. Never use this for
user input or direction. Use `abandon` only when the user redirects away from
the objective; it preserves a stopped record rather than declaring success.

Done when the returned Goal state accurately represents completed work,
remaining approved work, or the justified waiting/terminal condition.
