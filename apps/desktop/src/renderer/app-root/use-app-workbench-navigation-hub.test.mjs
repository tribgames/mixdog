import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppWorkbenchNavigationHub } from './use-app-workbench-navigation-hub.ts';

test('useAppWorkbenchNavigationHub aggregates workspace navigation and recent files', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let hookResult = null;
  const paneWorkspace = {
    leaves: [
      {
        id: 'leaf-1',
        tabs: [
          { kind: 'file', project: '/proj', rel: 'a.ts' },
          { kind: 'file', project: '/proj', rel: 'b.ts' },
        ],
        activeTabKey: 'file:/proj/a.ts',
      },
    ],
    focusedLeafId: 'leaf-1',
    focusedLeaf: {
      id: 'leaf-1',
      tabs: [{ kind: 'file', project: '/proj', rel: 'a.ts' }],
      activeTabKey: 'file:/proj/a.ts',
    },
    layout: { type: 'leaf', id: 'leaf-1' },
    focusLeaf: () => {},
    activateTab: () => {},
  };

  function TestHarness() {
    hookResult = useAppWorkbenchNavigationHub({
      paneWorkspace,
      requestedSessionId: '',
      focusedPaneSelection: { kind: 'file', project: '/proj', rel: 'a.ts' },
      activeTabKey: 'file:/proj/a.ts',
      navigateTab: () => {},
      focusPaneTypingSurface: () => {},
      activatePaneSurface: () => {},
      startTask: () => {},
      openSettings: () => {},
      toggleSidebar: () => {},
      toggleDock: () => {},
      toggleBottomPanel: () => {},
      setQuickAccessMode: () => {},
      openDockTab: () => {},
      navigateEditorHistory: () => false,
      editorNavigationHistory: { canUndo: false, canRedo: false },
      chooseFileTab: async () => {},
      activeFileKey: 'file:/proj/a.ts',
      editorSaveHandles: { current: new Map() },
      dirtyFileKeys: new Set(),
      bottomPanel: { open: false, tab: 'problems', setOpen: () => {}, setTab: () => {} },
      editorCommandCapabilities: { formatDocument: false },
      openTerminalTab: () => {},
      openStudioTab: () => {},
      toolProjectPath: '/proj',
      workbenchWorkspace: { workspace: { folders: [{ path: '/proj' }] } },
      quickAccessMode: null,
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);
  assert.equal(hookResult.quickAccessProjectPath, '/proj');
  assert.deepEqual(hookResult.quickAccessRecentFiles, ['a.ts', 'b.ts']);
  assert.ok(Array.isArray(hookResult.workbenchCommands));

  await act(async () => {
    root.unmount();
  });
});
