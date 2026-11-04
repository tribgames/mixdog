// The worktree list reads the host again only after something may have changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const calls = [];
const row = {
  id: 'fix-login',
  branch: 'fix-login',
  path: '/data/worktrees/fix-login',
  baseCommit: null,
  state: 'ready',
  projectPath: '/p/app',
  ownerSessionId: 's1',
  sharedSessionIds: [],
  retained: true,
  ownerLive: false,
  removable: false,
  dirty: 0,
  unmerged: 0,
  sizeBytes: 1024,
  sizeComplete: true,
  ownerTitle: 'Login fix',
  ownerArchived: false,
};
window.mixdogDesktop = {
  invokeCapability: async ({ capability, args }) => {
    calls.push(capability);
    if (capability === 'getWorktreeSettings') {
      return {
        value: {
          newTaskDefault: 'branch',
          branchPrefix: '',
          sizeWarnBytes: 1,
          autoCleanup: true,
          maxWorktrees: 15,
          unusedDays: 30,
          cleanupArchived: true,
          deleteBranch: false,
        },
      };
    }
    if (capability === 'listWorktrees') return { value: [row] };
    if (capability === 'deleteWorktree') return { value: { removed: { removed: true }, entryId: args[0].entryId } };
    throw new Error(`unexpected ${capability}`);
  },
};
const { overrideConfirmAction } = await import('../app-confirm.tsx');
const { WorktreeList, worktreeRowState } = await import('./worktree-list.tsx');

const settle = () => act(() => new Promise((resolve) => setImmediate(resolve)));
const lists = () => calls.filter((name) => name === 'listWorktrees').length;
const deleteButton = () =>
  [...document.querySelectorAll('.worktree-actions button')].find((button) => button.textContent === 'Delete');

test('a retained clean worktree the limits would delete is not called kept', () => {
  const settings = { autoCleanup: true, cleanupArchived: true };
  assert.equal(worktreeRowState(row, settings).text, 'Merged · kept');
  assert.equal(worktreeRowState({ ...row, cleanupReason: 'age' }, settings).text, 'Merged · will be cleaned up');
  assert.equal(worktreeRowState({ ...row, ownerArchived: true }, settings).text, 'Merged · will be cleaned up');
  assert.equal(worktreeRowState({ ...row, retained: false }, settings).text, 'Merged · deleted at next cleanup');
});

test('a cancelled delete reads nothing again; a confirmed one reloads the list once', async () => {
  const root = createRoot(document.getElementById('root'));
  let answer = false;
  overrideConfirmAction(() => answer);
  try {
    await act(async () => root.render(React.createElement(WorktreeList, { active: true })));
    await settle();
    assert.equal(lists(), 1);
    assert.match(document.querySelector('.worktree-session-link')?.textContent ?? '', /Login fix/);
    await act(async () => deleteButton().click());
    await settle();
    assert.equal(lists(), 1, 'cancelled: no reload (no folder walk)');
    assert.equal(calls.includes('deleteWorktree'), false);
    answer = true;
    await act(async () => deleteButton().click());
    await settle();
    assert.equal(calls.filter((name) => name === 'deleteWorktree').length, 1);
    assert.equal(lists(), 2);
  } finally {
    overrideConfirmAction(null);
    await act(async () => root.unmount());
  }
});
