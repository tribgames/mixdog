import assert from 'node:assert/strict';
import test from 'node:test';

import { applyWorktreeSettingsPatch, normalizeWorktreeSettings, WORKTREE_SETTINGS_DEFAULTS } from './settings.mjs';

test('defaults: worktrees off for new tasks, mixdog/ prefix, 2 GiB warning, conservative cleanup', () => {
  assert.deepEqual(normalizeWorktreeSettings(undefined), {
    newTaskDefault: 'branch',
    branchPrefix: 'mixdog/',
    sizeWarnBytes: 2147483648,
    autoCleanup: true,
  });
  assert.deepEqual(normalizeWorktreeSettings({}), WORKTREE_SETTINGS_DEFAULTS);
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
