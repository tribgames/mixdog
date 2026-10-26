import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { useEditorRevealRequest } = await import('./use-editor-reveal-request.ts');

function fakeEditor() {
  const calls = [];
  return {
    calls,
    setPosition: (position) => calls.push(['setPosition', position]),
    revealPositionInCenter: (position) => calls.push(['revealPositionInCenter', position]),
    revealLineInCenter: (line) => calls.push(['revealLineInCenter', line]),
    focus: () => calls.push(['focus']),
  };
}

async function mountHook(initial) {
  const editor = fakeEditor();
  const editorRef = { current: editor };
  const autoFocusRef = { current: initial.autoFocus ?? true };
  const navigations = [];
  const onNavigationLocationRef = { current: (...args) => navigations.push(args) };
  let revealSymbol;
  function Probe(props) {
    revealSymbol = useEditorRevealRequest({ editorRef, autoFocusRef, onNavigationLocationRef, ...props });
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (props) => act(async () => root.render(React.createElement(Probe, props)));
  await render(initial.props);
  return {
    editor,
    navigations,
    render,
    revealSymbol: () => revealSymbol,
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a reveal waits for the load, then jumps, focuses and reports the location', async () => {
  const reveal = { line: 12, nonce: 1 };
  const view = await mountHook({ props: { reveal, load: null, relPath: 'a.ts' } });
  try {
    assert.deepEqual(view.editor.calls, [], 'no jump before the file loads');
    await view.render({ reveal, load: { content: 'x' }, relPath: 'a.ts' });
    assert.deepEqual(view.editor.calls, [
      ['setPosition', { lineNumber: 12, column: 1 }],
      ['revealPositionInCenter', { lineNumber: 12, column: 1 }],
      ['focus'],
    ]);
    assert.deepEqual(view.navigations, [['a.ts', 12, 1]]);

    view.editor.calls.length = 0;
    await view.render({ reveal: { ...reveal }, load: { content: 'reloaded' }, relPath: 'a.ts' });
    assert.deepEqual(view.editor.calls, [], 'a content reload or a fresh object with the same keys does not re-jump');

    await view.render({ reveal: { line: 30, column: 4, nonce: 1 }, load: { content: 'x' }, relPath: 'a.ts' });
    assert.deepEqual(view.editor.calls[0], ['setPosition', { lineNumber: 30, column: 4 }], 'same nonce, new line');
  } finally {
    await view.dispose();
  }
});

test('without auto-focus the jump leaves focus alone; a breadcrumb symbol always focuses', async () => {
  const view = await mountHook({
    autoFocus: false,
    props: { reveal: { line: 3, column: 0, nonce: 5 }, load: {}, relPath: 'b.ts' },
  });
  try {
    assert.deepEqual(
      view.editor.calls.map(([name]) => name),
      ['setPosition', 'revealPositionInCenter']
    );
    const first = view.revealSymbol();
    view.editor.calls.length = 0;
    first({ line: 8, column: 0 });
    assert.deepEqual(view.editor.calls, [
      ['setPosition', { lineNumber: 8, column: 1 }],
      ['revealLineInCenter', 8],
      ['focus'],
    ]);
    await view.render({ reveal: null, load: {}, relPath: 'b.ts' });
    assert.equal(view.revealSymbol(), first, 'the symbol callback keeps its identity across renders');
  } finally {
    await view.dispose();
  }
});
