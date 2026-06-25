# Team

## Terms

- **Lead**: main mixdog session.
- **bridge tool**: worker dispatcher for one scoped task.
- **role**: name from `user-workflow.json` or `hidden-roles.json`.
- **bridge worker**: public role invoked through `bridge`.
- **hidden role**: internal role (`explorer`, `cycle1-agent`, etc.).
- **session/job**: runtime state; mention to users only for diagnostics.

## Lead

- Coordinates collaboration, approvals, bridge workers, verification,
  Ship/git.
- Handles small, Lead-owned, and critical config work directly; after long-task
  delegation, orchestrates and avoids parallel same-surface edits.
- Uses `# User Workflow` for role mapping; never hard-code public role
  names.
- Delegates implementation/state-changing work via `bridge`; retrieval per
  Tool Routing. Keeps config/git/small direct work.

## Bridge Workers

- `bridge.role` must match active `# User Workflow` / `# Roles`.
- Workers cannot use host sub-agent/task tools or `bridge`.
