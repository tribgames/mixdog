import assert from 'node:assert/strict';
import test from 'node:test';

import { applyWorktreeSettingsPatch, normalizeWorktreeSettings, WORKTREE_SETTINGS_DEFAULTS } from './settings.mjs';

test('defaults: worktrees off for new tasks, no branch prefix, 2 GiB warning, conservative cleanup', () => {
  assert.deepEqual(normalizeWorktreeSettings(undefined), {
    newTaskDefault: 'branch',
    branchPrefix: '',
    sizeWarnBytes: 2147483648,
    autoCleanup: true,
    maxWorktrees: 15,
    unusedDays: 30,
    cleanupArchived: true,
  });
  assert.deepEqual(normalizeWorktreeSettings({}), WORKTREE_SETTINGS_DEFAULTS);
});

test('a stored deleteBranch from an older version is ignored, dropped on the next save, and no longer settable', () => {
  assert.deepEqual(normalizeWorktreeSettings({ deleteBranch: true }), WORKTREE_SETTINGS_DEFAULTS);
  assert.deepEqual(applyWorktreeSettingsPatch({ deleteBranch: true, unusedDays: 7 }, { autoCleanup: false }), {
    ...WORKTREE_SETTINGS_DEFAULTS,
    unusedDays: 7,
    autoCleanup: false,
  });
  assert.throws(() => applyWorktreeSettingsPatch({}, { deleteBranch: true }), /is not a worktree setting/);
});

test('cleanup settings: counts and days are bounded integers, toggles booleans; 0 turns a limit off', () => {
  assert.deepEqual(applyWorktreeSettingsPatch({}, { maxWorktrees: 0, unusedDays: 7, cleanupArchived: false }), {
    ...WORKTREE_SETTINGS_DEFAULTS,
    maxWorktrees: 0,
    unusedDays: 7,
    cleanupArchived: false,
  });
  for (const patch of [
    { maxWorktrees: -1 },
    { maxWorktrees: 1001 },
    { maxWorktrees: 2.5 },
    { unusedDays: '30' },
    { unusedDays: 3651 },
    { cleanupArchived: 'no' },
  ]) {
    assert.throws(() => applyWorktreeSettingsPatch({}, patch), TypeError, JSON.stringify(patch));
  }
  assert.equal(normalizeWorktreeSettings({ maxWorktrees: -3 }).maxWorktrees, 15);
});

test('an empty branch prefix is valid; a saved non-default prefix is kept', () => {
  assert.equal(applyWorktreeSettingsPatch({ branchPrefix: 'team/' }, { branchPrefix: '' }).branchPrefix, '');
  assert.equal(normalizeWorktreeSettings({ branchPrefix: 'mixdog/' }).branchPrefix, 'mixdog/');
  assert.equal(normalizeWorktreeSettings({ branchPrefix: 'team/agents/' }).branchPrefix, 'team/agents/');
});

test('stored values are kept when valid and fall back per field when not', () => {
  assert.deepEqual(
    normalizeWorktreeSettings({
      newTaskDefault: 'worktree',
      branchPrefix: 'team/agents/',
      sizeWarnBytes: 'huge',
      autoCleanup: 'yes',
      unknown: 1,
    }),
    { ...WORKTREE_SETTINGS_DEFAULTS, newTaskDefault: 'worktree', branchPrefix: 'team/agents/' }
  );
});

test('the stored agent section keeps only non-default worktree values', async () => {
  const { stripAgentSectionDefaults } = await import('../defaults-separation.mjs');
  assert.deepEqual(stripAgentSectionDefaults({ worktree: { ...WORKTREE_SETTINGS_DEFAULTS } }), {});
  assert.deepEqual(stripAgentSectionDefaults({ worktree: { ...WORKTREE_SETTINGS_DEFAULTS, autoCleanup: false } }), {
    worktree: { autoCleanup: false },
  });
});

test('patches are strict', () => {
  assert.deepEqual(applyWorktreeSettingsPatch({ autoCleanup: false }, { sizeWarnBytes: 0 }), {
    ...WORKTREE_SETTINGS_DEFAULTS,
    autoCleanup: false,
    sizeWarnBytes: 0,
  });
  for (const patch of [
    {},
    { newTaskDefault: 'on' },
    { branchPrefix: 'mixdog' },
    { branchPrefix: '/mixdog/' },
    { branchPrefix: 'a..b/' },
    { branchPrefix: 'x.lock/' },
    { branchPrefix: 'a//' },
    { sizeWarnBytes: -1 },
    { sizeWarnBytes: 1.5 },
    { autoCleanup: 1 },
    { other: true },
  ]) {
    assert.throws(() => applyWorktreeSettingsPatch({}, patch), TypeError, JSON.stringify(patch));
  }
});
