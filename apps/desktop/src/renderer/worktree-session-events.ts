// Settings → Worktrees asks the app shell for a session: open one by id
// (the agent-task "Open" event), or start a New Task in an existing managed
// worktree (its project, with the worktree's branch chosen). The shell closes
// the settings dialog for both (AppShellOverlays.tsx).
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';

/** `detail: { projectPath, branch }`: handled in use-app-task-lifecycle.ts. */
export const NEW_TASK_IN_WORKTREE_EVENT = 'mixdog:new-task-in-worktree';

export interface NewTaskInWorktreeDetail {
  projectPath: string;
  branch: string;
}

export function requestOpenSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }));
}

export function requestNewTaskInWorktree(detail: NewTaskInWorktreeDetail): void {
  window.dispatchEvent(new CustomEvent(NEW_TASK_IN_WORKTREE_EVENT, { detail }));
}
