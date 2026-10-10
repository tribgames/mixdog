import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGE_SCROLLBAR_CSS, injectPageScrollbarCss } from './page-scrollbar-css.ts';

test('guest pages get the 8px shell scrollbar on every document', async () => {
  const handlers = new Map();
  const injected = [];
  injectPageScrollbarCss({
    on: (event, handler) => handlers.set(event, handler),
    insertCSS: async (css) => injected.push(css),
    isDestroyed: () => false,
  });
  handlers.get('dom-ready')();
  handlers.get('dom-ready')();
  assert.deepEqual(injected, [PAGE_SCROLLBAR_CSS, PAGE_SCROLLBAR_CSS]);
  assert.match(PAGE_SCROLLBAR_CSS, /::-webkit-scrollbar \{ width: 8px/);
  assert.match(PAGE_SCROLLBAR_CSS, /::-webkit-scrollbar-track \{ background: transparent/);
  assert.match(PAGE_SCROLLBAR_CSS, /::-webkit-scrollbar-button \{ display: none/);
  // Scrollbar pseudo-elements only: no layout rule touches the page.
  assert.doesNotMatch(PAGE_SCROLLBAR_CSS.replace(/::-webkit-scrollbar[^{]*\{[^}]*\}/g, ''), /\S/);
});

test('a destroyed guest is not injected', () => {
  const handlers = new Map();
  let calls = 0;
  injectPageScrollbarCss({
    on: (event, handler) => handlers.set(event, handler),
    insertCSS: async () => void calls++,
    isDestroyed: () => true,
  });
  handlers.get('dom-ready')();
  assert.equal(calls, 0);
});
