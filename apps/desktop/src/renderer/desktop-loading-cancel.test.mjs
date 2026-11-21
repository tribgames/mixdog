import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DesktopLoadingSurface } from './RendererRecovery.tsx';

async function mountCancellableCover() {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: [
      'navigator',
      'Node',
      'Element',
      'HTMLElement',
      'HTMLButtonElement',
      'Event',
      'KeyboardEvent',
      'MouseEvent',
    ],
  });
  const { document } = dom.window;
  const root = createRoot(document.getElementById('root'));
  const cancelled = { count: 0 };
  await act(async () => {
    root.render(
      React.createElement(DesktopLoadingSurface, {
        label: 'Loading view…',
        overlay: true,
        onCancel: () => {
          cancelled.count += 1;
        },
      })
    );
  });
  return { dom, document, cancelled, unmount: () => act(async () => root.unmount()) };
}

test('a loading cover without a cancel handler shows no cancel button', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'Node', 'Element', 'HTMLElement'],
  });
  const { document } = dom.window;
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(DesktopLoadingSurface, { label: 'Loading view…', overlay: true }));
  });
  assert.equal(document.querySelector('.desktop-loading-cancel'), null, 'no cancel without a handler');
  await act(async () => root.unmount());
});

test('a cancellable loading cover is left by its named button', async () => {
  const { dom, document, cancelled, unmount } = await mountCancellableCover();
  const button = document.querySelector('.desktop-loading-cancel');
  assert.ok(button, 'cancel button present');
  assert.ok(button.getAttribute('aria-label'), 'cancel button is named');
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(cancelled.count, 1, 'button cancels');
  await unmount();
});

test('a cancellable loading cover is left by a tap on the dim', async () => {
  const { dom, document, cancelled, unmount } = await mountCancellableCover();
  await act(async () => {
    const dim = document.querySelector('.desktop-loading-surface');
    dim.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    dim.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(cancelled.count, 1, 'a tap on the dim cancels');
  await unmount();
});

test('a cancellable loading cover is left by Escape', async () => {
  const { dom, document, cancelled, unmount } = await mountCancellableCover();
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(cancelled.count, 1, 'Escape cancels');
  await unmount();
});
