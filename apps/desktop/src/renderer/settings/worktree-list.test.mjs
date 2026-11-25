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
let listFailure;
let listRead;
let deleteFailure;
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
  cleanupReason: null,
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
    if (capability === 'listWorktrees') {
      await listRead;
      if (listFailure) throw listFailure;
      return { value: [row] };
    }
    if (capability === 'deleteWorktree') {
      if (deleteFailure && !args[0].force) throw deleteFailure;
      return { value: { removed: { removed: true }, entryId: args[0].entryId } };
    }
    throw new Error(`unexpected ${capability}`);
  },
};
const { overrideConfirmAction } = await import('../app-confirm.tsx');
const { WorktreeList, worktreeRowState } = await import('./worktree-list.tsx');

const settle = () => act(() => new Promise((resolve) => setImmediate(resolve)));
const lists = () => calls.filter((name) => name === 'listWorktrees').length;
const deleteButton = () =>
  [...document.querySelectorAll('.worktree-actions button')].find((button) => button.textContent === 'Delete');
const cleanupButton = () =>
  [...document.querySelectorAll('.worktree-list button')].find((button) => button.textContent === 'Clean up now');

test('a retained merged worktree is called kept only when the list reports no cleanup selection', () => {
  const settings = { autoCleanup: true, cleanupArchived: true };
  assert.equal(worktreeRowState(row, settings).text, 'Merged · kept');
  assert.equal(worktreeRowState({ ...row, cleanupReason: undefined }, settings).text, 'Merged');
  assert.equal(worktreeRowState({ ...row, cleanupReason: 'age' }, settings).text, 'Merged · cleanup candidate');
  assert.equal(worktreeRowState({ ...row, ownerArchived: true }, settings).text, 'Merged · cleanup candidate');
  assert.equal(
    worktreeRowState({ ...row, retained: false, removable: true }, settings).text,
    'Merged · cleanup candidate'
  );
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

test('an external Git change refreshes the list and a failed read keeps the last known row', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(WorktreeList)));
    await settle();
    assert.equal(deleteButton()?.disabled, false);
    const read = Promise.withResolvers();
    listRead = read.promise;
    listFailure = new Error('could not read worktrees');
    await act(async () => window.dispatchEvent(new Event('mixdog:git-changed')));
    assert.equal(deleteButton()?.disabled, true, 'delete is disabled before the read completes');
    assert.equal(cleanupButton()?.disabled, true, 'cleanup is disabled before the read completes');
    await act(async () => read.resolve());
    assert.equal(deleteButton()?.disabled, true, 'a failed read cannot make the list current');
    assert.match(document.querySelector('.worktree-session-link')?.textContent ?? '', /Login fix/);
    assert.match(
      document.querySelector('.worktree-list [role="status"]')?.textContent ?? '',
      /could not read worktrees/
    );
  } finally {
    listRead = undefined;
    listFailure = undefined;
    await act(async () => root.unmount());
  }
});

test('a state change withdraws either delete confirmation before a stale approval can reach Git', async () => {
  for (const force of [false, true]) {
    const root = createRoot(document.getElementById('root'));
    const answer = Promise.withResolvers();
    const offered = Promise.withResolvers();
    const deletesBefore = calls.filter((name) => name === 'deleteWorktree').length;
    let questions = 0;
    deleteFailure = force ? Object.assign(new Error('dirty'), { code: 'WORKTREE_DIRTY' }) : undefined;
    overrideConfirmAction((_message, { signal }) => {
      if (++questions === 1 && force) return true;
      offered.resolve(signal);
      return answer.promise;
    });
    try {
      await act(async () => root.render(React.createElement(WorktreeList)));
      await settle();
      await act(async () => deleteButton().click());
      const signal = await offered.promise;
      await act(async () => window.dispatchEvent(new Event('mixdog:git-changed')));
      assert.equal(signal.aborted, true);
      await act(async () => answer.resolve(true));
      assert.equal(calls.filter((name) => name === 'deleteWorktree').length - deletesBefore, force ? 1 : 0);
    } finally {
      answer.resolve(false);
      deleteFailure = undefined;
      overrideConfirmAction(null);
      await act(async () => root.unmount());
    }
  }
});

test('the refresh icon button in the list header reads the list again', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(WorktreeList, { active: true })));
    await settle();
    const before = lists();
    const refresh = document.querySelector('.worktree-list .settings-group-head button[aria-label="Refresh"]');
    assert.ok(refresh, 'the header has a labelled refresh button');
    assert.equal(refresh.textContent, '', 'the refresh button shows an icon, not text');
    await act(async () => refresh.click());
    await settle();
    assert.equal(lists(), before + 1);
  } finally {
    await act(async () => root.unmount());
  }
});
