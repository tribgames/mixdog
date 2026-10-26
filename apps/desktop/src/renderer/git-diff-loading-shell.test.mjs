// While the diff loads, the pane shows its own Loading shell with working
// controls and exactly one header: no readiness cover, no second header row in
// the dock.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ReadyGitDiffPane } from './app-shell-components.tsx';
import { DockHeaderRow } from './pane-dock-chrome.tsx';

const h = React.createElement;
const selection = { kind: 'diff', project: 'C:/proj', source: 'unstaged', rel: 'src/cart.js' };

async function mountLoading(t, build) {
  const { dom, root } = installTestDom(t, {
    html: '<!doctype html><body><main id="root"></main></body>',
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = { gitDiff: () => new Promise(() => {}) };
  await act(async () => root.render(build()));
  return dom.window.document.getElementById('root');
}

test('a loading diff pane renders its own shell, one header and a working close button', async (t) => {
  let closed = 0;
  const container = await mountLoading(t, () =>
    h(ReadyGitDiffPane, { selection, active: true, onClose: () => closed++ })
  );
  assert.equal(container.querySelectorAll('.workspace-git-diff-header').length, 1);
  const state = container.querySelectorAll('.workspace-git-diff-state');
  assert.equal(state.length, 1);
  assert.match(state[0].textContent, /Loading diff…/);
  const close = container.querySelector('.workspace-git-diff-header button[aria-label="Close diff"]');
  assert.ok(close, 'the close control has an accessible name');
  await act(async () => close.click());
  assert.equal(closed, 1);
});

test('in the side dock the loading diff adds no header row of its own beside the dock header', async (t) => {
  const container = await mountLoading(t, () =>
    h(
      'div',
      null,
      h(DockHeaderRow, { left: h('b', null, 'Changes'), onClose() {} }),
      h(ReadyGitDiffPane, { selection, active: true, chrome: 'side', onClose() {} })
    )
  );
  assert.equal(container.querySelectorAll('[data-dock-header]').length, 1);
  assert.equal(container.querySelectorAll('.workspace-git-diff-header').length, 0);
  assert.match(container.querySelector('.workspace-git-diff-state').textContent, /Loading diff…/);
  assert.ok(container.querySelector('[aria-label="Close panel"]'), 'the dock header keeps its close control');
});
