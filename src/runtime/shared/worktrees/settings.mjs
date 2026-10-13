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
 * @property {string} branchPrefix Ref prefix for created branches; ends with "/".
 * @property {number} sizeWarnBytes Repository size that asks for confirmation; 0 never asks.
 * @property {boolean} autoCleanup Remove clean, merged worktrees when their session ends.
 */

/** @type {Readonly<WorktreeSettings>} */
export const WORKTREE_SETTINGS_DEFAULTS = Object.freeze({
  newTaskDefault: 'branch',
  branchPrefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
  sizeWarnBytes: 2 * 1024 ** 3,
  autoCleanup: true,
});

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
      return typeof value === 'string' &&
        value.length <= 64 &&
        PREFIX_PATTERN.test(value) &&
        !value.includes('..') &&
        !/\.lock\//i.test(value)
        ? null
        : 'must be a ref path ending with "/", e.g. "mixdog/"';
    case 'sizeWarnBytes':
      return Number.isSafeInteger(value) && value >= 0 ? null : 'must be a non-negative integer';
    case 'autoCleanup':
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
