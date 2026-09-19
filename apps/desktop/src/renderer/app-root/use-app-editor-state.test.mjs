import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppEditorState } from './use-app-editor-state.ts';

test('useAppEditorState manages dirty file keys and editor save handles', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let pinnedKey = '';
  const paneWorkspace = {
    leaves: [],
    pinTabByKey: (key) => {
      pinnedKey = key;
    },
  };

  let hookResult = null;
  function TestHarness() {
    hookResult = useAppEditorState({
      paneWorkspace,
      startupFocusedPaneSelection: null,
      bottomPanel: { open: false, tab: 'problems', setOpen: () => {}, setTab: () => {} },
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);
  assert.equal(hookResult.dirtyFileKeys.size, 0);

  // Mark file dirty
  await act(async () => {
    hookResult.handleFileDirty('file-1', true);
  });
  assert.equal(hookResult.dirtyFileKeys.has('file-1'), true);
  assert.equal(pinnedKey, 'file-1');

  // Register save handle
  const saveFn = async () => {};
  hookResult.registerEditorSaveHandle('file-1', saveFn);
  assert.equal(hookResult.editorSaveHandles.current.get('file-1'), saveFn);

  // Unmark dirty
  await act(async () => {
    hookResult.handleFileDirty('file-1', false);
  });
  assert.equal(hookResult.dirtyFileKeys.has('file-1'), false);

  await act(async () => {
    root.unmount();
  });
});
