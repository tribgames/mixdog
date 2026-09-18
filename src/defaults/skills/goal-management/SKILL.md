---
name: goal-management
description: Manage durable goals, task progress, approvals, and completion.
when_to_use: 'Explicit Goal requests, delegated or approved time-budgeted work, or managing existing Goals; not ordinary tasks, planning, estimates, deadlines, or round counts alone.'
dependencies:
  tools:
    - type: tool
      value: goal
---

# Goal management

Use `goal` to maintain durable tasks and their idle reminders. The tool schema
owns arguments and limits; this guide owns the lifecycle and completion policy.

## Admission and current state

Create a Goal for an explicit user or system/developer Goal request, or user
delegation or approval of sustained work with a time budget. The user need not
name Goal: approval of an assistant-proposed scope and budget also qualifies.
Resolve a short approval against the preceding proposal and retain any user
constraints. An unaccepted assistant proposal is not authorization.

Ordinary tasks, complexity, planning, estimates, deadlines, and round counts
alone do not qualify. If work needs approval, obtain it first; then create the
Goal, or reconcile an existing one, before starting the approved work,
including execution-stage exploration. An existing Goal does not authorize
new scope.

For creation, use the requested or approved budget for `time_limit_minutes`;
omit it when an explicit Goal request has no budget. An upper bound uses
`time_mode: max`; use `duration` only when the user explicitly requests work
for the full period.

Use the latest returned state and revision. If unknown or stale, read `status`
and reconcile before mutating. Never replay a stale mutation blindly.
For multi-step work, record the approved milestones and keep them durable.
One-step work does not need a ceremonial plan or a separate verification row.

## Additional rounds

An approved request to continue for another period changes the work commitment,
not just the conversation. Reconcile the Goal before research or execution:

- For the same unfinished objective, use `resume` with the approved remaining
  budget in `time_limit_minutes` and new tasks or task updates in one call.
  This also covers a paused Goal or exhausted budget with all old rows done.
  Preserve completed rows and unfinished requirements; record the new round's
  work rather than leaving the old completed checklist unchanged.
- The resume budget runs from now and retains elapsed work. Omit it for a
  plain continuation with no approved time change. Preserve `time_mode`
  unless the new request explicitly changes the time commitment.
- If the prior Goal is complete or stopped, create a new Goal for the approved
  round; the runtime archives the prior record. Do not falsely complete or
  abandon unfinished work merely to get a fresh clock.
- Proceed only after the returned state has the intended active status,
  remaining budget, and tasks. A statement that work will continue is not a
  substitute for the mutation. Reconcile a rejected update before continuing.

## Maintain progress

- Update tasks at meaningful milestones and scope changes. Preserve unfinished
  requirements; drop a task only after the user changes its scope.
- Prefer `update_tasks` for changed items; `set_tasks` replaces the full list.
  Serialize mutations to the same Goal. `resume` accepts updates and additions
  atomically. Starting approved work can resume a user-answer wait or a
  cancelled-turn pause, never a user-initiated pause. Bookkeeping alone does
  not authorize execution.
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

A cancelled turn pauses the Goal with `pauseReason: cancelled`. The user stopped
that turn, not the objective, and only the stop control retires a Goal. Judge the
next instruction: resume and continue the work when it carries this objective
forward or redirects it, and leave the Goal paused when it is unrelated or asks
you to stay stopped.

Each continuation should do concrete work or wait on a verified live handle.
Evidence that changes the next action is progress; repeated reports and plan
updates alone are not. Reassess a no-progress turn and take the next safe action.
Observation timeouts do not terminate the observed work or justify restarting it.

## Completion and recovery

Distinguish a turn boundary, objective completion, and a budget stop. A Goal
can stay active across turn-ending progress reports; never present such a
report as completion of the whole objective.

Complete only after auditing every user condition against evidence. Reuse valid
checks; a separate verification task is optional, verification itself is not.
A maximum time budget allows verified early completion. A full-period
commitment does not. Preserve an existing Goal's time mode; never extend its
budget or change its meaning on your own.
Do not end a Goal merely because a partial result is available.

For an achieved objective, reconcile the task records, call `complete`, and
check the returned status before claiming Goal completion. A tool call or a
plausible final response is not itself confirmation.

### Time-budget extension

Elapsed-time budgets are a Mixdog extension to the persistent Goal lifecycle.
Keep `max` upper bounds distinct from explicitly requested `duration` periods.
An advance deadline warning does not stop the Goal or request an early final
report; prioritize bounded approved work and needed verification. Do not invent
unfinished tasks merely to represent remaining clock time.

At the boundary, the runtime first records `duration_reached`, disables
automatic Goal work, and delivers closeout without cancelling the current
turn. Finish or safely park only in-flight work, then report once. The elapsed
period proves only that the time condition ended: call `complete` only if the
whole objective is verified; otherwise retain unfinished tasks and the limited
status. Do not resume or extend the Goal without the user's approval.

### Blocked and redirected work

Report a genuine external impasse with `block` once per turn, with a stable
description of the same condition. The runtime stops after three consecutive
turns confirm it; until then continue any available work. Never use this for
user input or direction. Use `abandon` only when the user redirects away from
the objective; it preserves a stopped record rather than declaring success.

Done when the returned Goal state accurately represents completed work,
remaining approved work, or the justified waiting/terminal condition.
