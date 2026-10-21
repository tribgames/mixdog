import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DesktopLoadingSurface } from './RendererRecovery.tsx';

// The full-screen cover a lazy view (the usage dialog) shows while its chunk
// loads: on a phone it hides everything, so it must carry its own way out.
test('a cancellable loading cover can be left by its button, a tap on the dim and Escape', async () => {
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
  let cancelled = 0;
  const render = (onCancel) =>
    act(async () => {
      root.render(React.createElement(DesktopLoadingSurface, { label: 'Loading view…', overlay: true, onCancel }));
    });

  await render(undefined);
  assert.equal(document.querySelector('.desktop-loading-cancel'), null, 'no cancel without a handler');

  await render(() => {
    cancelled += 1;
  });
  const button = document.querySelector('.desktop-loading-cancel');
  assert.ok(button, 'cancel button present');
  assert.ok(button.getAttribute('aria-label'), 'cancel button is named');

  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(cancelled, 1, 'button cancels');

  await act(async () => {
    const dim = document.querySelector('.desktop-loading-surface');
    dim.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    dim.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(cancelled, 2, 'a tap on the dim cancels');

  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(cancelled, 3, 'Escape cancels');

  await act(async () => root.unmount());
});
