import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppTabActions } from './use-app-tab-actions.ts';

test('useAppTabActions manages utility, studio, terminal, and diff tab opening', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const tabs = [];
  const setTabs = (update) => {
    const next = typeof update === 'function' ? update(tabs) : update;
    tabs.length = 0;
    tabs.push(...next);
  };

  const focusedSelections = [];
  let terminalSelected = false;

  const paneWorkspace = {
    leaves: [{ id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' }],
    focusedLeafId: 'leaf-1',
    focusedLeaf: { id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' },
    focusLeaf: (_id) => {},
    openInFocused: (sel) => {
      focusedSelections.push(sel);
    },
    splitFocused: () => {},
  };

  let hookResult = null;

  function TestHarness() {
    hookResult = useAppTabActions({
      paneWorkspace,
      setTabs,
      closeSidebarPanels: () => {},
      setSessionSideSurface: (_id, surface) => {
        if (surface === 'terminal') terminalSelected = true;
      },
      paneSideDocks: {
        select: () => {},
        temporarySelect: () => {},
      },
      sessionPaneSurfaces: {
        browserSurfaces: new Map(),
        pendingBrowserAutoReveal: { current: new Set() },
        browserAutoRevealSuppressed: { current: new Set() },
      },
      openFileTab: () => {},
      openSession: async () => {},
      activeProjectPath: '/p',
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);

  // 1. openTerminalTab for a session leaf sets terminal side surface
  hookResult.openTerminalTab('leaf-1');
  assert.equal(terminalSelected, true);

  // 2. openDiffTab adds diff tab and opens in focused pane
  hookResult.openDiffTab('/repo', '\\src\\index.ts', { source: 'working' });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].selection.kind, 'diff');
  assert.equal(tabs[0].selection.rel, 'src/index.ts');
  assert.equal(focusedSelections.length, 1);
  assert.equal(focusedSelections[0].kind, 'diff');

  await act(async () => {
    root.unmount();
  });
});
