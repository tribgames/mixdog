# Agent Tasks

Agent tasks are Mixdog's delegation layer. Lead uses them when a scoped piece of
work can run independently while Lead keeps planning, integrating, testing, or
responding to the user.

## Terminology

- **Agent**: a workflow role such as `worker`, `reviewer`, `debugger`,
  `maintainer`, or `heavy-worker`.
- **Task**: one async unit of delegated work.
- **task_id**: the stable ID used to read, check, cancel, or close a task.
- **Tag**: a human-readable handle for an agent session, useful for follow-up
  messages.

Use `task`, `task_id`, and `Agent` in user-facing text and docs.

## TUI Commands

```text
/agents
/agent
/agent list
/agent spawn <agent> [sync|async] <prompt>
/agent send <tag|sessionId> [sync|async] <message>
/agent status <task_id>
/agent read <task_id>
/agent cancel <task_id|tag|sessionId>
/agent close <task_id|tag|sessionId>
/agent cleanup
```

`/agents` lists configured workflow agents. `/agent` manages active agent tasks.

## Tool Contract

The model-facing tool is `agent`.

Common inputs:

- `type`: `spawn`, `send`, `list`, `status`, `read`, `cancel`, `close`, or
  `cleanup`.
- `mode`: always `async` for model handoffs.
- `agent` or `role`: workflow agent ID.
- `tag`: stable handle for a parallel agent.
- `prompt` or `message`: scoped task brief.
- `task_id`: manual recovery ID for `status`, `read`, and `cancel`.
- `cwd`: working directory for the task.

Normal model flow:

1. Spawn independent agents early with distinct tags.
2. Continue Lead-side work that does not require those task results.
3. Wait for completion notifications only when the dependent path needs them.
4. Use `status` or `read` only for manual recovery or explicit user requests.

## Output Shape

Async task starts and notifications use this visible shape:

```text
agent task: task_agent_...
status: running
type: spawn
target: worker-tag sess_...
agent: worker
model: provider/model
notification: completion will be delivered to the owner session; use read/status only for manual recovery.
```

Queued follow-up messages use:

```text
agent message queued
target: worker-tag sess_...
agent: worker
queueDepth: 1
```

List output uses:

```text
agent mode: async
agents: 1
tasks: 1
```

## Responsibilities

Lead keeps ownership of:

- User discussion, requirements, plan, and approval gates.
- Git, commits, pushes, builds, deploys, and release decisions.
- Final integration, verification, and user-facing summary.

Agents can own:

- Scoped implementation.
- Focused codebase research.
- Review and debugging.
- Maintenance or heavier independent analysis.

Agents should not perform git commit/push/stash or release/deploy work.
