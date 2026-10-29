import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// Every reveal is stamped with Date.now(), so two jumps raised in the same
// millisecond carry the SAME nonce. The hook must still move the editor to the
// second line; a nonce-only dependency would keep the first one's position.
test('a reveal request jumps on a new line even when the nonce is unchanged, and on a repeat of the same line', async (t) => {
  const { root } = installTestDom(t, { rootId: 'root' });
  const { useEditorRevealRequest } = await import('./use-editor-reveal-request.ts');
  const jumps = [];
  const editor = {
    setPosition: (position) => jumps.push(['set', position.lineNumber, position.column]),
    revealPositionInCenter() {},
    focus() {},
  };
  const located = [];
  const refs = {
    editorRef: { current: editor },
    autoFocusRef: { current: false },
    onNavigationLocationRef: { current: (...args) => located.push(args) },
  };
  function Probe(props) {
    useEditorRevealRequest({ ...refs, load: {}, relPath: 'a.ts', ...props });
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Probe, props)));

  await render({ reveal: { line: 3, nonce: 7 } });
  await render({ reveal: { line: 9, nonce: 7 } });
  assert.deepEqual(jumps, [
    ['set', 3, 1],
    ['set', 9, 1],
  ]);
  await render({ reveal: { line: 9, nonce: 8 } });
  assert.deepEqual(jumps.at(-1), ['set', 9, 1], 'a repeat jump to the same line re-runs');
  assert.equal(jumps.length, 3);
  await render({ reveal: { line: 9, nonce: 8 }, relPath: 'b.ts' });
  assert.deepEqual(located.at(-1), ['b.ts', 9, 1], "the reveal follows this pane's own file");
  assert.equal(jumps.length, 4);
  await render({ reveal: { line: 9, nonce: 8 }, relPath: 'b.ts' });
  assert.equal(jumps.length, 4, 'an unchanged request does not jump again');
});

test('opening a file at a line stamps a reveal with the current time; opening without a line raises none', async (t) => {
  const { root } = installTestDom(t, { rootId: 'root' });
  t.mock.timers.enable({ apis: ['Date'], now: 5000 });
  const { useEditorNavigation } = await import('./use-editor-navigation.ts');
  let nav;
  function Probe() {
    nav = useEditorNavigation({ setTabs() {}, openSelectionInFocusedPane() {} });
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  assert.equal(nav.fileReveal, null);
  await act(async () => nav.openFileTab('/p', 'a.ts', 12));
  assert.equal(nav.fileReveal.line, 12);
  assert.equal(nav.fileReveal.nonce, 5000);
  // A second jump in the same millisecond keeps the nonce; only the line differs.
  await act(async () => nav.openFileTab('/p', 'a.ts', 30));
  assert.deepEqual([nav.fileReveal.line, nav.fileReveal.nonce], [30, 5000]);
  const before = nav.fileReveal;
  await act(async () => nav.openFileTab('/p', 'b.ts'));
  assert.equal(nav.fileReveal, before, 'no line, no reveal request');
});
