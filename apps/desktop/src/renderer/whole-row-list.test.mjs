import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  expose: ['Node', 'HTMLElement', 'MutationObserver', 'getComputedStyle'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
after(restore);

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { useWholeRowList, wholeRowCut } = await import('./whole-row-list.ts');

// Rows of 52px between 7px paddings, as in the agents panel.
const rows = (count) => Array.from({ length: count }, (_, i) => ({ top: 7 + i * 52, bottom: 7 + (i + 1) * 52 }));

test('a capped list ends under the last row that fits whole', () => {
  // The 320px cap held 5.9 rows: the list now ends after the fifth.
  assert.equal(wholeRowCut(rows(9), 320, 482, 7), 7 + 5 * 52 + 7);
  // A row that fits exactly, end padding included, is kept.
  assert.equal(wholeRowCut(rows(9), 7 + 6 * 52 + 7, 482, 7), 7 + 6 * 52 + 7);
});

// The stylesheet caps the list at 40dvh; the inline cut must follow it when
// only the window gets shorter (a PC window resized, a phone keyboard opening).
test('an open list is cut again when the viewport gets shorter', async (t) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  let cap = 320;
  function List() {
    const ref = React.useRef(null);
    useWholeRowList(ref);
    return React.createElement(
      'ul',
      {
        ref: (node) => {
          ref.current = node;
          if (!node) return;
          const inline = () => Number.parseFloat(node.style.maxHeight) || Number.POSITIVE_INFINITY;
          Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => Math.min(cap, inline()) });
          Object.defineProperty(node, 'scrollHeight', { configurable: true, value: 7 + 9 * 52 + 7 });
        },
        style: { paddingBottom: '7px' },
      },
      rows(9).map((row, index) =>
        React.createElement('li', {
          key: index,
          ref: (node) => {
            if (!node) return;
            Object.defineProperty(node, 'offsetTop', { configurable: true, value: row.top });
            Object.defineProperty(node, 'offsetHeight', { configurable: true, value: row.bottom - row.top });
          },
        })
      )
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => {
    act(() => root.unmount());
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  await act(async () => root.render(React.createElement(List)));
  const list = host.querySelector('ul');
  assert.equal(list.style.maxHeight, `${7 + 5 * 52 + 7}px`);
  cap = 200;
  window.dispatchEvent(new window.Event('resize'));
  for (const frame of frames.splice(0)) frame();
  assert.equal(list.style.maxHeight, `${7 + 3 * 52 + 7}px`, 'the shorter cap holds three whole rows');
});

test('a list that fits is left alone, and one taller than its first row keeps the cap', () => {
  assert.equal(wholeRowCut(rows(3), 320, 170, 7), null);
  assert.equal(wholeRowCut([{ top: 7, bottom: 400 }], 320, 407, 7), 320);
});
