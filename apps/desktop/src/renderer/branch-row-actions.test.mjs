import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
const { overrideConfirmAction } = await import('./app-confirm.tsx');
installTestDom();
const { createRoot } = await import('react-dom/client');
const { BranchRowActions } = await import('./branch-row-actions.tsx');
const { setUiLanguagePreference, initUiLanguage } = await import('./i18n.ts');

async function fixture(t, over = {}) {
  setUiLanguagePreference('en');
  await initUiLanguage();
  const calls = [];
  const view = {
    branch: 'feature/login',
    commit: 'a'.repeat(40),
    target: 'main',
    targetCommit: 'b'.repeat(40),
    path: '/worktree',
    worktreeId: 'login',
    kind: 'managed',
    ...over,
  };
  window.mixdogDesktop = {
    async invokeCapability(request) {
      calls.push(request);
      return { value: request.capability === 'inspectProjectBranch' ? view : { merged: true }, snapshot: null };
    },
    async openLocalFileLink(...args) {
      calls.push({ open: args });
      return 'folder';
    },
  };
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail.text);
  window.addEventListener('mixdog:desktop-toast', onToast);
  t.after(() => window.removeEventListener('mixdog:desktop-toast', onToast));
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  let refreshed = 0;
  await act(async () =>
    root.render(
      React.createElement(BranchRowActions, {
        branch: view.branch,
        projectPath: '/project',
        locked: false,
        onChanged: async () => {
          refreshed += 1;
        },
      })
    )
  );
  t.after(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  // Selecting an item closes the menu, so each action reopens it.
  const open = () => act(async () => node.querySelector('button').click());
  await open();
  return {
    node,
    open,
    calls,
    view,
    refreshed: () => refreshed,
    toasts,
    button: (text) =>
      [...document.body.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes(text)),
  };
}

test('branch actions inspect without switching, and merge sends confirmed commit identities', async (t) => {
  const f = await fixture(t);
  overrideConfirmAction(() => false);
  await act(async () => f.button('Merge into main').click());
  assert.equal(f.calls.length, 1);
  overrideConfirmAction(() => true);
  await f.open();
  await act(async () => f.button('Merge into main').click());
  assert.deepEqual(f.calls.at(-1), {
    capability: 'manageProjectBranch',
    args: [
      {
        projectPath: '/project',
        branch: f.view.branch,
        action: 'merge',
        commit: f.view.commit,
        target: 'main',
        targetCommit: f.view.targetCommit,
        confirmed: true,
      },
    ],
  });
  assert.equal(f.refreshed(), 1);
});
test('refusals read exactly like the runtime (TUI, remote) in English and are translated elsewhere', async (t) => {
  const { WORKTREE_REFUSAL_REASONS } = await import('../../../../src/runtime/shared/worktrees/contract.mjs');
  const { DESKTOP_WORKTREE_REFUSAL_REASONS } = await import('../shared/contract.ts');
  assert.deepEqual([...DESKTOP_WORKTREE_REFUSAL_REASONS].sort(), Object.keys(WORKTREE_REFUSAL_REASONS).sort());
  const f = await fixture(t);
  overrideConfirmAction(() => true);
  const inspect = window.mixdogDesktop.invokeCapability;
  const shown = async (reason) => {
    window.mixdogDesktop.invokeCapability = inspect;
    if (!document.body.querySelector('[role="menu"]')) await f.open();
    const merge = document.body.querySelector('[data-action-id="merge"]');
    window.mixdogDesktop.invokeCapability = async () => {
      throw new Error(
        `Error invoking remote method: WORKTREE_BUSY_JOBS: ${WORKTREE_REFUSAL_REASONS[reason]}\n[worktree-details] ${JSON.stringify({ reason })}`
      );
    };
    f.toasts.length = 0;
    await act(async () => merge.click());
    return f.toasts.at(-1);
  };
  for (const reason of Object.keys(WORKTREE_REFUSAL_REASONS)) {
    assert.equal(await shown(reason), WORKTREE_REFUSAL_REASONS[reason]);
  }
  setUiLanguagePreference('ko');
  await initUiLanguage();
  t.after(() => setUiLanguagePreference('en'));
  for (const reason of Object.keys(WORKTREE_REFUSAL_REASONS)) {
    const text = await shown(reason);
    assert.ok(text && text !== WORKTREE_REFUSAL_REASONS[reason], `${reason} is translated`);
  }
});

test('right-click or a touch long-press on the row opens the same menu at the press point', async (t) => {
  const f = await fixture(t);
  await act(async () => f.node.querySelector('.branch-row-more').click());
  assert.equal(document.body.querySelector('[role="menu"]'), null);
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  await act(async () => f.node.querySelector('.branch-row-shell').dispatchEvent(event));
  assert.equal(event.defaultPrevented, true, 'the long-press is taken, so the tap does not switch branches');
  assert.ok(f.button('Merge into main'));
});

test('external folders can open but cannot be cleaned or have their checked-out branch deleted', async (t) => {
  const f = await fixture(t, { kind: 'external', worktreeId: null });
  assert.equal(f.button('Remove worktree folder').disabled, true);
  assert.equal(f.button('Delete branch').disabled, true);
  await act(async () => f.button('Open folder').click());
  assert.deepEqual(f.calls.at(-1), { open: ['/worktree', '.'] });
});
