// Opening a file on the phone must not raise the soft keyboard over it: the
// editor's mount and activation take focus only off the phone layout. A tap
// into the text still focuses Monaco itself.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore, dom } = installTestDom(null, {
  html: '<!doctype html><html><body><main id="root"></main></body></html>',
  expose: ['Node', 'HTMLElement'],
});
after(restore);
dom.window.requestAnimationFrame = (callback) => {
  callback(16);
  return 1;
};
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;

const { createRoot } = await import('react-dom/client');
const { useEditorActiveDocument } = await import('./use-editor-active-document.ts');
const { useEditorMountSession } = await import('./use-editor-mount-session.ts');

function fakeEditor(focusCalls) {
  const host = document.createElement('div');
  const node = document.createElement('div');
  host.append(node);
  return {
    getDomNode: () => node,
    getModel: () => null,
    getPosition: () => null,
    focus: () => focusCalls.push('focus'),
    restoreViewState() {},
  };
}

function Probe({ autoFocus, editor, onMount }) {
  const editorRef = useRef(editor);
  const activeRef = useRef(true);
  const focusedRef = useRef(true);
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  useEditorActiveDocument({
    editorRef,
    editorLayoutSize: useRef(null),
    layoutEditorToHost() {},
    onNavigationLocationRef: useRef(undefined),
    active: true,
    focused: true,
    autoFocus,
    revealed: true,
    loaded: { content: '' },
    viewMode: 'source',
    modelUri: null,
    projectPath: 'C:/p',
    relPath: 'biome.json',
    updateOutline: async () => {},
  });
  const mount = useEditorMountSession({
    editorRef,
    editorLayoutObserver: useRef(null),
    editorLayoutSize: useRef(null),
    scheduleEditorLayout() {},
    armFonts() {},
    bindModel() {},
    wireCommands() {},
    activeRef,
    focusedRef,
    autoFocusRef,
    savedText: useRef(''),
    projectPath: 'C:/p',
    relPath: 'biome.json',
    viewStateKey: 'c:/p/biome.json',
    readViewState: () => null,
    markDirty() {},
    renderAnsiOutput() {},
    notifyReady() {},
  });
  onMount.current = mount;
  return null;
}

async function opened(autoFocus) {
  const focusCalls = [];
  const editor = fakeEditor(focusCalls);
  const onMount = { current: null };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe, { autoFocus, editor, onMount })));
  await act(async () => onMount.current(editor));
  await act(async () => root.unmount());
  return focusCalls;
}

test('the phone layout opens a file without focusing the editor', async () => {
  assert.deepEqual(await opened(false), []);
});

test('the desktop layout still focuses the opened editor on activation and mount', async () => {
  assert.deepEqual(await opened(true), ['focus', 'focus']);
});
