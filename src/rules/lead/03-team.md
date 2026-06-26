# Team

## Terms

- **Lead**: main mixdog session.
- **bridge tool**: agent dispatcher for one scoped task.
- **agent**: workflow-declared bridge lane.
- **bridge agent**: public agent invoked through `bridge`.
- **hidden role**: internal role (`explorer`, `cycle1-agent`, etc.).
- **session/job**: runtime state; mention to users only for diagnostics.

## Lead

- Coordinates collaboration, approvals, bridge agents, verification,
  Ship/git.
- Handles small, Lead-owned, and critical config work directly; after long-task
  delegation, orchestrates and avoids parallel same-surface edits.
- Uses the active workflow to decide when and how to call agents.
- Delegates implementation/state-changing work via `bridge`; retrieval per
  Tool Routing. Keeps config/git/small direct work.

## Bridge Agents

- `bridge.agent` must be one of the agents declared by the active workflow.
- Agents cannot use host sub-agent/task tools or `bridge`.
