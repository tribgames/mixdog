// A core failure as the window sees it: shared/core-error.ts, a worktree code then framed as Node's IPC wrapper did (the page gets only the message).
import { coreFailure } from '../../shared/core-error';
import { worktreeErrorWithCode } from '../worktree-validation';

export function coreErrorForWindow(error: unknown): unknown {
  return coreFailure(error, worktreeErrorWithCode);
}
