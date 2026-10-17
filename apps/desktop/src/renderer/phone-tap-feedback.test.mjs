import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

function installPhone() {
  const installed = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['Element', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent'],
    globals: { navigator: { userAgent: ANDROID_PHONE, platform: 'Linux armv8l', maxTouchPoints: 5 } },
  });
  const { window } = installed;
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  window.HTMLElement.prototype.attachEvent = () => {};
  window.HTMLElement.prototype.detachEvent = () => {};
  globalThis.ResizeObserver = window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver ??= window.MutationObserver;
  return installed;
}

test('the drawer intent stamp paints at the tap, survives stale commits and settles once the commit agrees', async () => {
  const { restore, document } = installPhone();
  try {
    const { paintDrawerIntent, settleDrawerIntent, drawerIntentOpen } = await import('./drawer-intent.ts');
    const root = document.documentElement;
    assert.equal(drawerIntentOpen(true), true, 'no stamp: the committed state answers');
    paintDrawerIntent(true);
    assert.equal(root.getAttribute('data-drawer-intent'), 'open');
    settleDrawerIntent(false, true);
    assert.equal(
      root.getAttribute('data-drawer-intent'),
      'open',
      'a commit that still shows the old state keeps the stamp'
    );
    paintDrawerIntent(false);
    assert.equal(
      drawerIntentOpen(true),
      false,
      'a rapid second tap toggles from the stamped intent, not the stale state'
    );
    settleDrawerIntent(true, false);
    assert.equal(root.getAttribute('data-drawer-intent'), 'closed');
    settleDrawerIntent(false, false);
    assert.equal(root.hasAttribute('data-drawer-intent'), false, 'the matching commit clears the stamp');
  } finally {
    restore();
  }
});

test('phone +: the pill names the new task on the tap, before the navigation commits', async () => {
  const { restore, document } = installPhone();
  try {
    const { createRoot } = await import('react-dom/client');
    const { WorkspaceTabStrip } = await import('./WorkspaceTabStrip.tsx');
    const session = { key: 'session:s1', title: 'Existing chat', selection: { kind: 'session', id: 's1' } };
    const draft = { key: 'new:d1', title: 'New task', selection: { kind: 'new', draftId: 'd1' } };
    let newTasks = 0;
    const host = document.getElementById('root');
    const root = createRoot(host);
    const render = (tabs, activeKey) =>
      act(async () =>
        root.render(
          React.createElement(WorkspaceTabStrip, {
            tabs,
            activeKey,
            onSelectTab() {},
            onCloseTab() {},
            onReorderTab() {},
            onPinTab() {},
            onNewTask() {
              newTasks += 1;
            },
          })
        )
      );
    await render([session], session.key);
    const pill = () => host.querySelector('.workspace-tab-compact-current span')?.textContent;
    assert.equal(pill(), 'Existing chat');
    await act(async () => host.querySelector('.workspace-tab-new').click());
    assert.equal(newTasks, 1, 'the navigation is still requested');
    assert.equal(pill(), 'New task', 'the pill answers the tap while the shell has not navigated');
    await render([session, draft], draft.key);
    assert.equal(pill(), 'New task', 'the committed draft tab now owns the pill');
    await render([session, draft], session.key);
    assert.equal(pill(), 'Existing chat', 'returning to the old tab must not replay the tap');
    await act(async () => root.unmount());
  } finally {
    restore();
  }
});

test('phone dock toggles press on the tap and hand the open to the shell as a transition', async () => {
  const { restore, document } = installPhone();
  try {
    const { createRoot } = await import('react-dom/client');
    const { PaneDockToggles } = await import('./pane-dock-toggles.tsx');
    const Icon = () => React.createElement('span');
    const descriptors = new Map([['session-diff', { id: 'session-diff', label: 'Changes', icon: Icon }]]);
    const groups = [['session-diff']];
    const calls = [];
    const host = document.getElementById('root');
    const root = createRoot(host);
    const render = (activeRoot) =>
      act(async () =>
        root.render(
          React.createElement(PaneDockToggles, {
            groups,
            descriptors,
            activeRoot,
            sessionBound: true,
            onSelect: (id) => calls.push(['select', id]),
            onClose: () => calls.push(['close']),
          })
        )
      );
    await render(null);
    const toggle = () => host.querySelector('.pane-dock-toggle');
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    await act(async () => toggle().click());
    assert.deepEqual(calls, [['select', 'session-diff']]);
    assert.equal(toggle().getAttribute('aria-pressed'), 'true', 'pressed before the shell has answered');
    await render('session-diff');
    assert.equal(toggle().getAttribute('aria-pressed'), 'true', 'the shell answer keeps it pressed');
    await act(async () => toggle().click());
    assert.deepEqual(calls.at(-1), ['close']);
    assert.equal(toggle().getAttribute('aria-pressed'), 'false', 'folding also answers on the tap');
    await render(null);
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    await act(async () => root.unmount());
  } finally {
    restore();
  }
});
