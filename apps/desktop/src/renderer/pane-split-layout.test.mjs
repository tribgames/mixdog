import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { PaneSplitLayout } from './PaneSplitLayout.tsx';

const h = React.createElement;

test('PaneSplitLayout unconditionally restores React-owned flex before onRatioChange on clamped commit', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'PointerEvent', 'requestAnimationFrame', 'cancelAnimationFrame'],
    rootId: 'root',
  });
  const rafCallbacks = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  t.after(() => {
    act(() => root.unmount());
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  });

  const node = {
    type: 'split',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'leaf', id: 'p1', tabs: [], activeTabId: '' },
    second: { type: 'leaf', id: 'p2', tabs: [], activeTabId: '' },
  };
  const committed = [];
  const flexAtCommit = [];

  await act(async () =>
    root.render(
      h(PaneSplitLayout, {
        node,
        renderLeaf: (leaf) => h('div', null, leaf.id),
        onRatioChange: (_path, nextRatio) => {
          const cells = document.querySelectorAll('.pane-split-cell');
          flexAtCommit.push([cells[0].style.flex, cells[1].style.flex]);
          committed.push(nextRatio);
          // Simulate parent clamping nextRatio back to the unchanged 0.5 ratio (no React re-render of style.flex).
        },
      })
    )
  );

  const split = document.querySelector('.pane-split');
  const cells = document.querySelectorAll('.pane-split-cell');
  const handle = document.querySelector('.pane-resize-handle');
  const initialFirstFlex = cells[0].style.flex;
  const initialSecondFlex = cells[1].style.flex;

  split.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 });
  const captured = new Set();
  handle.setPointerCapture = (id) => captured.add(id);
  handle.hasPointerCapture = (id) => captured.has(id);
  handle.releasePointerCapture = (id) => captured.delete(id);

  const PointerEventCtor = dom.window.PointerEvent ?? dom.window.MouseEvent;
  await act(async () => {
    handle.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, pointerId: 1, clientX: 500 }));
    handle.dispatchEvent(new PointerEventCtor('pointermove', { bubbles: true, pointerId: 1, clientX: 700 }));
    for (const cb of rafCallbacks.splice(0)) cb(16);
  });

  // Preview mutated style.flex imperatively during drag.
  assert.notEqual(cells[0].style.flex, initialFirstFlex, 'drag preview updates flex imperatively');

  await act(async () => {
    handle.dispatchEvent(new PointerEventCtor('pointerup', { bubbles: true, pointerId: 1, clientX: 700 }));
  });

  assert.equal(committed.length, 1);
  assert.deepEqual(
    flexAtCommit[0],
    [initialFirstFlex, initialSecondFlex],
    'React-owned style.flex is restored before onRatioChange runs'
  );
  assert.equal(cells[0].style.flex, initialFirstFlex, 'clamped commit leaves first cell flex in sync with React');
  assert.equal(cells[1].style.flex, initialSecondFlex, 'clamped commit leaves second cell flex in sync with React');
});
