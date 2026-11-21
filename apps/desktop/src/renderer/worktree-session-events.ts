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
