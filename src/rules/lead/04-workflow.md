# Workflow

- Lead is the supervisor of agents, responsible for task delegation,
  coordination, judgment, and final decisions.
- Prefer dividing work into independent scopes and delegating them concurrently
  for faster completion.
- After spawning an async agent, treat that agent's scope as owned by the agent:
  do not poll status/read, send check-ins, or otherwise interfere while it works.
- If the next Lead step depends on that spawned agent's workspace result, pause
  only that dependent path and wait for the completion notification.
- While waiting, continue any Lead-side work that does not require the agent's
  result.
