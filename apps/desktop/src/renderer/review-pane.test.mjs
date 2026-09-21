// A multi-file patch keys each diff body by file name. Interpolating the
// `{fileName, content}` objects instead collapsed every file onto the single
// key "[object Object]\n[object Object]", so React could reuse one file's diff
// body for another.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const DOM_GLOBALS = ['window', 'document', 'Node', 'HTMLElement', 'Event'];
const savedGlobals = DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
for (const key of DOM_GLOBALS) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { createRoot } = await import('react-dom/client');
const { GitFileDiff } = await import('./ReviewPane.tsx');

// Binary sections carry no hunks, so both files render their synchronous
// fallback body — the keys are the only thing under test.
const PATCH = [
  'diff --git a/one.bin b/one.bin',
  'index 1111111..2222222 100644',
  'Binary files a/one.bin and b/one.bin differ',
  'diff --git a/two.bin b/two.bin',
  'index 3333333..4444444 100644',
  'Binary files a/two.bin and b/two.bin differ',
  '',
].join('\n');

test('each file of a multi-file patch renders under its own key', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map((value) => String(value)).join(' '));
  t.after(async () => {
    console.error = originalError;
    await act(async () => root.unmount());
    host.remove();
  });

  await act(async () => root.render(React.createElement(GitFileDiff, { patch: PATCH, mode: 'unified' })));

  const bodies = [...host.querySelectorAll('.diff-fallback')].map((node) => node.textContent);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /one\.bin/);
  assert.match(bodies[1], /two\.bin/);
  assert.deepEqual(
    errors.filter((message) => /same key/i.test(message)),
    []
  );
});
