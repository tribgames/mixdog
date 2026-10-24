// The Work mode page stays mounted (hidden) while the settings dialog is
// closed, so it watches the host's worktree settings only while the dialog is
// showing: every opening revalidates, a closed dialog reads nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useLayoutEffect } from 'react';
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

let host = { newTaskDefault: 'branch', branchPrefix: 'mixdog/', sizeWarnBytes: 1024 ** 3, autoCleanup: false };
let reads = 0;
window.mixdogDesktop = {
  invokeCapability: async ({ capability }) => {
    assert.equal(capability, 'getWorktreeSettings');
    reads++;
    return { value: { ...host } };
  },
};
const { WorktreeSettings } = await import('./worktree-settings.tsx');
const { SETUP_CHANGED_EVENT } = await import('../setup-change-refresh.ts');
const { loadWorktreeSettings } = await import('./worktree-settings-store.ts');

const settle = () => act(() => new Promise((resolve) => setImmediate(resolve)));
const prefix = () => document.querySelector('input[name="worktreeBranchPrefix"]')?.value;
const announce = () =>
  window.dispatchEvent(new CustomEvent(SETUP_CHANGED_EVENT, { detail: { action: 'set_worktree_settings' } }));

test('a retained page revalidates on each opening and reads nothing while closed', async () => {
  // The settings module's load fills the cache before the page ever mounts.
  await loadWorktreeSettings();
  assert.equal(reads, 1);
  const root = createRoot(document.getElementById('root'));
  // What the very commit of an opening shows, before any effect has run.
  let firstCommit;
  function Probe({ active }) {
    useLayoutEffect(() => {
      firstCommit ??= prefix();
    });
    return React.createElement(WorktreeSettings, { active });
  }
  const render = (active) => act(async () => root.render(React.createElement(Probe, { active })));
  try {
    // Mounted hidden (the dialog is closed): the cached value, no read.
    await render(false);
    await settle();
    assert.equal(prefix(), 'mixdog/');
    assert.equal(reads, 1);
    // Opened: the cached value is there in the first commit, then revalidated.
    host = { ...host, branchPrefix: 'elsewhere/' };
    firstCommit = undefined;
    await render(true);
    assert.equal(firstCommit, 'mixdog/');
    await settle();
    assert.equal(reads, 2);
    assert.equal(prefix(), 'elsewhere/');
    // Open: an announced setup change re-reads.
    host = { ...host, branchPrefix: 'setup-tool/' };
    announce();
    await settle();
    assert.equal(prefix(), 'setup-tool/');
    // Closed but still mounted: a change elsewhere and an announcement read nothing.
    await render(false);
    host = { ...host, branchPrefix: 'while-closed/' };
    announce();
    await settle();
    assert.equal(reads, 3);
    assert.equal(prefix(), 'setup-tool/');
    // Reopened: the change made while closed shows.
    await render(true);
    await settle();
    assert.equal(reads, 4);
    assert.equal(prefix(), 'while-closed/');
  } finally {
    await act(async () => root.unmount());
  }
});
