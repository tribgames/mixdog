import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
});
const { placeFixedSurface } = await import('./surface-slots.ts');

test('a fixed surface lands on its slot when the phone body is offset by a panned visual viewport', () => {
  const document = dom.window.document;
  const container = document.createElement('div');
  document.body.appendChild(container);
  // The phone body (position: fixed + transform) follows the visual viewport,
  // so it is the containing block and sits at the panned origin.
  document.body.getBoundingClientRect = () => ({ left: 12, top: 30, right: 424, bottom: 900, width: 412, height: 870 });
  const slot = { left: 12, top: 74, width: 412, height: 826 };

  document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  placeFixedSurface(container, slot);
  assert.deepEqual(
    [container.style.left, container.style.top, container.style.width, container.style.height],
    ['0px', '44px', '412px', '826px']
  );

  // Desktop: the viewport is the containing block, coordinates apply as-is.
  document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
  placeFixedSurface(container, slot);
  assert.deepEqual([container.style.left, container.style.top], ['12px', '74px']);
});
