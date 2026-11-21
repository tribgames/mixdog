import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppEditorState } from './use-app-editor-state.ts';

async function mountEditorState() {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });
  const pinned = { key: '' };
  const paneWorkspace = {
    leaves: [],
    pinTabByKey: (key) => {
      pinned.key = key;
    },
  };
  const hook = { current: null };
  function TestHarness() {
    hook.current = useAppEditorState({
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
  return { hook, pinned, unmount: () => act(async () => root.unmount()) };
}

test('useAppEditorState tracks dirty file keys and pins the dirty tab', async () => {
  const { hook, pinned, unmount } = await mountEditorState();
  assert.equal(hook.current.dirtyFileKeys.size, 0);

  await act(async () => {
    hook.current.handleFileDirty('file-1', true);
  });
  assert.equal(hook.current.dirtyFileKeys.has('file-1'), true);
  assert.equal(pinned.key, 'file-1');

  await act(async () => {
    hook.current.handleFileDirty('file-1', false);
  });
  assert.equal(hook.current.dirtyFileKeys.has('file-1'), false);
  await unmount();
});

test('useAppEditorState releases only the editor save handle a pane registered', async () => {
  const { hook, unmount } = await mountEditorState();
  const saveFn = async () => {};
  hook.current.registerEditorSaveHandle('file-1', saveFn);
  assert.equal(hook.current.editorSaveHandles.current.get('file-1'), saveFn);

  const nextOwner = { save: async () => true, discard: async () => {} };
  hook.current.registerEditorSaveHandle('file-1', nextOwner);
  hook.current.registerEditorSaveHandle('file-1', null, saveFn);
  assert.equal(hook.current.editorSaveHandles.current.get('file-1'), nextOwner);
  hook.current.registerEditorSaveHandle('file-1', null, nextOwner);
  assert.equal(hook.current.editorSaveHandles.current.has('file-1'), false);
  await unmount();
});
