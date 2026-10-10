import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useResizeGesture } from './resize-gesture.ts';

function Handle({ log }) {
  const gesture = useResizeGesture((commit) => log.push(commit ? 'commit' : 'revert'));
  return React.createElement('div', {
    id: 'handle',
    onPointerDown: (event) => gesture.begin(event),
    ...gesture.handlers,
  });
}

async function run(end) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['Element', 'HTMLElement', 'Node'],
  });
  const log = [];
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(Handle, { log })));
    const handle = document.getElementById('handle');
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    await act(async () => handle.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
    await act(async () => end(handle, dom.window));
    // A second end signal for the same gesture (e.g. lostpointercapture after pointerup) is ignored.
    await act(async () => handle.dispatchEvent(new dom.window.Event('lostpointercapture', { bubbles: true })));
    return log;
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

test('pointerup commits once', async () => {
  assert.deepEqual(await run((h, w) => h.dispatchEvent(new w.Event('pointerup', { bubbles: true }))), ['commit']);
});

test('pointercancel, lostpointercapture and window blur revert', async () => {
  assert.deepEqual(await run((h, w) => h.dispatchEvent(new w.Event('pointercancel', { bubbles: true }))), ['revert']);
  assert.deepEqual(await run((h, w) => h.dispatchEvent(new w.Event('lostpointercapture', { bubbles: true }))), [
    'revert',
  ]);
  assert.deepEqual(await run((_h, w) => w.dispatchEvent(new w.Event('blur'))), ['revert']);
});
