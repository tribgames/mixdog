// Who may change worktrees from a chat (the git tool's managed-worktree
// operations, the daemon's cross-session `worktree` control). A worktree
// mutation — entering, returning, merging, removing, pruning, `git worktree
// add/remove`, a snapshot — runs only in a conversation session: a Lead
// session of the desktop or TUI, or a bot's chat. Unattended runs (schedules,
// webhooks, routines, room seats) are refused by the run's trusted identity;
// delegated workers have no worktree host at all. Listing stays open.
//
// The scope is the session-level caller scope (schedule-access.mjs
// scheduleCallerScope: the session's provenance and its unattended-run mark),
// never anything the model or a message supplies.
import { scheduleCallerScope } from './schedule-access.mjs';

/** `{ kind, agentId?, unattended?, attended }` of a calling session record. */
export function worktreeCallerScope(session) {
  const scope = scheduleCallerScope(session);
  const attended = (scope.kind === 'human' || scope.kind === 'agent') && scope.unattended !== true;
  return { ...scope, attended };
}

/** Throws unless `scope` (worktreeCallerScope) may change worktrees; `what` names the refused action. */
export function assertWorktreeMutationAllowed(scope, what) {
  if (scope?.attended === true) return;
  throw new Error(
    `${what} changes worktrees only in a conversation session (a Lead session or a bot chat); schedule, webhook, routine and room runs may only list them`
  );
}
