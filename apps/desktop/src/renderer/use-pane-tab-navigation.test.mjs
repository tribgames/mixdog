import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

// React DOM reads the document when it loads (its input-event support among it): the DOM comes first.
installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Element', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver ??= window.MutationObserver;
window.mixdogDesktop = {};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useAppPaneChrome } = await import('./use-app-pane-chrome.tsx');
const { usePaneTabNavigation } = await import('./use-pane-tab-navigation.ts');
const { navigationKey } = await import('./text-format.ts');

const pullRequest = (number) => ({
  kind: 'pull-request',
  project: '/p',
  number,
  title: `PR ${number}`,
  mode: 'overview',
});
const frames = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

test('a tab clicked in an unfocused pane takes typing focus to that pane, not the one focused before', async (t) => {
  const left = { type: 'leaf', id: 'left', tabs: [pullRequest(1)], activeKey: navigationKey(pullRequest(1)) };
  const right = {
    type: 'leaf',
    id: 'right',
    tabs: [pullRequest(2), pullRequest(3)],
    activeKey: navigationKey(pullRequest(2)),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const paneWorkspace = { focusedLeafId: 'left', focusLeaf() {}, activateTab() {}, reorderTab() {} };
  function Harness() {
    // The render before the click: the left pane is the focused one.
    const { navigateTab } = usePaneTabNavigation({
      focusedLeafId: 'left',
      activeTabKey: left.activeKey,
      openSelectionInFocusedPane() {},
      setComposerFocusRequest() {},
      startTask() {},
      startProject() {},
      openSession() {},
    });
    const chrome = useAppPaneChrome({
      tabs: [],
      sessions: [],
      paneWorkspace,
      dirtyFileKeys: new Set(),
      workingSessionIds: new Set(),
      unreadSessionIds: new Set(),
      selectionRef: { current: { kind: 'new' } },
      viewedSessionRef: { current: '' },
      unreadViewedSessionRef: { current: '' },
      setSelection() {},
      startTask() {},
      activateSelection() {},
      openFileTab() {},
      startProject() {},
      navigateTab,
      closeTab() {},
      pinPaneTab() {},
      renameSession: async () => {},
      lastSessionStorageKey: 'test:last-session',
    });
    return React.createElement(
      React.Fragment,
      null,
      [left, right].map((leaf) =>
        React.createElement(
          'div',
          { key: leaf.id, 'data-pane-id': leaf.id },
          chrome.paneStripFor(leaf),
          React.createElement(
            'div',
            { 'data-surface-active': 'true' },
            React.createElement(
              'div',
              { className: 'monaco-editor' },
              React.createElement('textarea', { className: 'inputarea', 'data-editor-of': leaf.id })
            )
          )
        )
      )
    );
  }
  await act(async () => root.render(React.createElement(Harness)));
  const editorOf = (leafId) => host.querySelector(`textarea[data-editor-of="${leafId}"]`);
  for (const leafId of ['left', 'right']) editorOf(leafId).getClientRects = () => [{}];
  editorOf('left').focus();

  const tab = host.querySelector(
    `[data-pane-id="right"] .workspace-tab[data-tab-key="${navigationKey(pullRequest(3))}"] .workspace-tab-main`
  );
  assert.ok(tab, 'the right pane strip lists the tab');
  await act(async () => tab.click());
  await frames();

  assert.equal(document.activeElement, editorOf('right'));
});
