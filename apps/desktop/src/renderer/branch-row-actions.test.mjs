import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
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
  await act(async () => node.querySelector('button').click());
  return {
    node,
    calls,
    view,
    refreshed: () => refreshed,
    button: (text) => [...node.querySelectorAll('button')].find((button) => button.textContent.includes(text)),
  };
}

test('branch actions inspect without switching, and merge sends confirmed commit identities', async (t) => {
  const f = await fixture(t);
  window.confirm = () => false;
  await act(async () => f.button('Merge into main').click());
  assert.equal(f.calls.length, 1);
  window.confirm = () => true;
  await act(async () => f.button('Merge into main').click());
  assert.deepEqual(f.calls[1], {
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
  window.confirm = () => true;
  // Kept across the language switch, whose label is translated.
  const merge = f.button('Merge into main');
  const shown = async (reason) => {
    window.mixdogDesktop.invokeCapability = async () => {
      throw new Error(
        `Error invoking remote method: WORKTREE_BUSY_JOBS: ${WORKTREE_REFUSAL_REASONS[reason]}\n[worktree-details] ${JSON.stringify({ reason })}`
      );
    };
    await act(async () => merge.click());
    return f.node.querySelector('[role="alert"]').textContent;
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

test('external folders can open but cannot be cleaned or have their checked-out branch deleted', async (t) => {
  const f = await fixture(t, { kind: 'external', worktreeId: null });
  assert.equal(f.button('Remove worktree folder').disabled, true);
  assert.equal(f.button('Delete branch').disabled, true);
  await act(async () => f.button('Open folder').click());
  assert.deepEqual(f.calls.at(-1), { open: ['/worktree', '.'] });
});
