// Node b6f10295a `WORKTREE_ERROR_CODES` (runtime/shared/worktrees/contract.mjs) and `WORKTREE_NEW_TASK_DEFAULTS`
// (runtime/shared/worktrees/settings.mjs), recorded.
import { readFileSync } from 'node:fs';

const recorded = JSON.parse(readFileSync(new URL('./worktree-contract.recorded.json', import.meta.url), 'utf8'));
export const WORKTREE_ERROR_CODES = recorded.WORKTREE_ERROR_CODES;
export const WORKTREE_NEW_TASK_DEFAULTS = recorded.WORKTREE_NEW_TASK_DEFAULTS;
