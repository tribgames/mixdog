// A hidden window delivers no ResizeObserver callbacks, and that callback was the
// only way an unmounted row left the virtualizer's element cache: a long session
// running behind other windows kept every row it ever mounted, detached, with its
// whole DOM subtree, until the window was shown again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement'],
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Virtualizer } = await import('@tanstack/virtual-core');
const { useTranscriptRowRegistration } = await import('./transcript-list-row-registration.ts');

test('rows unmounted while no ResizeObserver delivers leave the element cache', async () => {
  const keys = Array.from({ length: 40 }, (_, index) => `row:${index}`);
  // No scroll element, so no target window: the core's observer never delivers.
  const virtualizer = new Virtualizer({
    count: keys.length,
    getScrollElement: () => null,
    estimateSize: () => 20,
    getItemKey: (index) => keys[index],
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  const virtualizerRef = { current: virtualizer };
  const spacer = { current: null };
  const content = { current: null };
  let measureRow;
  const List = ({ from, to }) => {
    ({ measureRow } = useTranscriptRowRegistration({ spacer, content, virtualizerRef }));
    return React.createElement(
      'div',
      null,
      keys.slice(from, to).map((key, offset) =>
        React.createElement('div', { key, 'data-index': from + offset, ref: measureRow }, key)
      )
    );
  };
  const host = document.getElementById('root');
  const root = createRoot(host);
  // Stream through the transcript: each window of rows replaces the last.
  for (let from = 0; from + 10 <= keys.length; from += 10) {
    await act(async () => root.render(React.createElement(List, { from, to: from + 10 })));
  }
  await act(async () => {});
  const cached = [...virtualizer.elementsCache.values()];
  assert.equal(cached.filter((element) => !element.isConnected).length, 0);
  assert.deepEqual(
    [...virtualizer.elementsCache.keys()].sort(),
    keys.slice(30).sort(),
    'mounted rows stay registered'
  );
  await act(async () => root.unmount());
});
