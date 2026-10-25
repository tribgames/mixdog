import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
});

const { usePaneWorkspace } = await import('./pane-workspace-state.ts');
const { navigationKey } = await import('./text-format.ts');

async function mountWorkspace(t) {
  let current;
  function Harness() {
    current = usePaneWorkspace(null);
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const run = (command) => act(async () => command(current));
  const groups = () =>
    current.leaves.map((leaf) => ({
      tabs: leaf.tabs.map((tab) => navigationKey(tab)),
      active: leaf.activeKey,
      focused: leaf.id === current.focusedLeafId,
    }));
  return { run, groups, workspace: () => current };
}

const session = (id) => ({ kind: 'session', id });

test('a split opened with no source pane moves the session: one pane per session', async (t) => {
  const { run, groups, workspace } = await mountWorkspace(t);
  await run((w) => w.openInFocused(session('a')));
  await run((w) => w.openInFocused(session('b')));
  const [only] = workspace().leaves.map((leaf) => leaf.id);
  // "Open to the side" (no drag source) of a session another tab of the pane holds.
  await run((w) => w.splitLeafAt(only, 'right', session('a'), ''));
  assert.deepEqual(groups(), [
    { tabs: ['session:b'], active: 'session:b', focused: false },
    { tabs: ['session:a'], active: 'session:a', focused: true },
  ]);
  // Again, beside the pane now showing it from elsewhere: still one copy.
  const [left] = workspace().leaves.map((leaf) => leaf.id);
  await run((w) => w.splitLeafAt(left, 'left', session('a'), ''));
  const keys = workspace().leaves.flatMap((leaf) => leaf.tabs.map((tab) => navigationKey(tab)));
  assert.equal(keys.filter((key) => key === 'session:a').length, 1);
});

test('pane commands keep one live surface per view and hand focus to the right group', async (t) => {
  const { run, groups, workspace } = await mountWorkspace(t);

  await run((w) => w.openInFocused(session('a')));
  await run((w) => w.openInFocused(session('b')));
  assert.deepEqual(groups(), [{ tabs: ['session:a', 'session:b'], active: 'session:b', focused: true }]);

  await run((w) => w.splitFocused('row', session('c')));
  const [left, right] = workspace().leaves.map((leaf) => leaf.id);
  assert.deepEqual(groups(), [
    { tabs: ['session:a', 'session:b'], active: 'session:b', focused: false },
    { tabs: ['session:c'], active: 'session:c', focused: true },
  ]);

  // A view open in another group is revealed there, not duplicated.
  await run((w) => w.openInFocused(session('a')));
  assert.deepEqual(groups(), [
    { tabs: ['session:a', 'session:b'], active: 'session:a', focused: true },
    { tabs: ['session:c'], active: 'session:c', focused: false },
  ]);

  await run((w) => w.moveTab(left, 'session:b', right));
  assert.deepEqual(groups(), [
    { tabs: ['session:a'], active: 'session:a', focused: false },
    { tabs: ['session:c', 'session:b'], active: 'session:b', focused: true },
  ]);

  // Closing a group's only tab collapses it into its sibling.
  await run((w) => w.focusLeaf(left));
  await run((w) => w.closeTab(left, 'session:a'));
  assert.deepEqual(groups(), [{ tabs: ['session:c', 'session:b'], active: 'session:b', focused: true }]);
  assert.equal(workspace().focusedLeafId, right);

  // Drag-to-split MOVES the tab out of its group.
  await run((w) => w.splitLeafAt(right, 'left', session('b'), right));
  assert.deepEqual(groups(), [
    { tabs: ['session:b'], active: 'session:b', focused: true },
    { tabs: ['session:c'], active: 'session:c', focused: false },
  ]);

  await run((w) => w.closeTabByKey('session:b'));
  assert.deepEqual(groups(), [{ tabs: ['session:c'], active: 'session:c', focused: true }]);

  // A drop into a group moves an open view there.
  await run((w) => w.splitFocused('column', session('d')));
  await run((w) => w.openInLeaf(right, session('d')));
  assert.deepEqual(groups(), [{ tabs: ['session:c', 'session:d'], active: 'session:d', focused: true }]);

  // The last tab closes into a fresh New task, which itself stays put.
  await run((w) => w.closeTabByKey('session:c'));
  await run((w) => w.closeTabByKey('session:d'));
  assert.equal(groups().length, 1);
  assert.equal(workspace().leaves[0].tabs[0].kind, 'new');
  const sole = workspace().layout;
  await run((w) => w.closeLeaf(w.focusedLeafId));
  assert.equal(workspace().layout, sole);
});
