/**
 * Worktree settings, persisted at agent config `worktree`. Defaults live in
 * code; the stored section holds only what the user changed.
 */
import { isPlainObject } from '../object.mjs';
import { DEFAULT_WORKTREE_BRANCH_PREFIX } from './contract.mjs';

/** `branch`: new tasks use the project folder's current branch (worktree off). */
export const WORKTREE_NEW_TASK_DEFAULTS = Object.freeze(['branch', 'worktree']);

/**
 * @typedef {object} WorktreeSettings
 * @property {'branch'|'worktree'} newTaskDefault
 * @property {string} branchPrefix Ref prefix for created branches, ending with "/";
 *   "" (default) names the branch after the task alone.
 * @property {number} sizeWarnBytes Repository size that asks for confirmation; 0 never asks.
 * @property {boolean} autoCleanup Remove clean, merged worktrees when their session ends.
 *   The four settings below apply only while it is on.
 * @property {number} maxWorktrees Keep at most this many managed worktrees (oldest
 *   activity cleaned first); 0 keeps any number.
 * @property {number} unusedDays Clean up worktrees unused this many days; 0 never.
 * @property {boolean} cleanupArchived Archiving a session makes its worktrees disposable.
 * @property {boolean} deleteBranch Cleanup deletes the worktree's branch too (its tip
 *   stays under the recovery ref); off keeps the branch.
 */

/** @type {Readonly<WorktreeSettings>} */
export const WORKTREE_SETTINGS_DEFAULTS = Object.freeze({
  newTaskDefault: 'branch',
  branchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
  sizeWarnBytes: 2 * 1024 ** 3,
  autoCleanup: true,
  maxWorktrees: 15,
  unusedDays: 30,
  cleanupArchived: true,
  deleteBranch: false,
});

export const WORKTREE_MAX_WORKTREES_LIMIT = 1000;
export const WORKTREE_UNUSED_DAYS_LIMIT = 3650;

const KEYS = Object.keys(WORKTREE_SETTINGS_DEFAULTS);
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/$/;

/** Why `value` cannot be stored for `key`, or null. */
function fieldError(key, value) {
  switch (key) {
    case 'newTaskDefault':
      return WORKTREE_NEW_TASK_DEFAULTS.includes(value)
        ? null
        : `must be one of ${WORKTREE_NEW_TASK_DEFAULTS.join(', ')}`;
    case 'branchPrefix':
      return value === '' ||
        (typeof value === 'string' &&
          value.length <= 64 &&
          PREFIX_PATTERN.test(value) &&
          !value.includes('..') &&
          !/\.lock\//i.test(value))
        ? null
        : 'must be empty or a ref path ending with "/", e.g. "mixdog/"';
    case 'sizeWarnBytes':
      return Number.isSafeInteger(value) && value >= 0 ? null : 'must be a non-negative integer';
    case 'maxWorktrees':
      return Number.isSafeInteger(value) && value >= 0 && value <= WORKTREE_MAX_WORKTREES_LIMIT
        ? null
        : `must be an integer from 0 to ${WORKTREE_MAX_WORKTREES_LIMIT}`;
    case 'unusedDays':
      return Number.isSafeInteger(value) && value >= 0 && value <= WORKTREE_UNUSED_DAYS_LIMIT
        ? null
        : `must be an integer from 0 to ${WORKTREE_UNUSED_DAYS_LIMIT}`;
    case 'autoCleanup':
    case 'cleanupArchived':
    case 'deleteBranch':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    default:
      return 'is not a worktree setting';
  }
}

/**
 * Effective settings from the stored section. Invalid stored values fall back
 * to their default so a hand edit never breaks boot.
 * @param {unknown} stored
 * @returns {WorktreeSettings}
 */
export function normalizeWorktreeSettings(stored) {
  const source = isPlainObject(stored) ? stored : {};
  const settings = { ...WORKTREE_SETTINGS_DEFAULTS };
  for (const key of KEYS) {
    if (Object.hasOwn(source, key) && fieldError(key, source[key]) === null) settings[key] = source[key];
  }
  return settings;
}

/**
 * Apply a user patch strictly: unknown keys and invalid values throw.
 * @param {unknown} current Stored or effective settings.
 * @param {Partial<WorktreeSettings>} patch
 * @returns {WorktreeSettings}
 */
export function applyWorktreeSettingsPatch(current, patch) {
  if (!isPlainObject(patch) || !Object.keys(patch).length) {
    throw new TypeError('worktree settings require at least one setting.');
  }
  for (const [key, value] of Object.entries(patch)) {
    const error = fieldError(key, value);
    if (error) throw new TypeError(`worktree.${key} ${error}.`);
  }
  return { ...normalizeWorktreeSettings(current), ...patch };
}
