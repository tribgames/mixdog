// A multi-file patch keys each diff body by file name. Interpolating the
// `{fileName, content}` objects instead collapsed every file onto the single
// key "[object Object]\n[object Object]", so React could reuse one file's diff
// body for another.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event'],
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { GitFileDiff, ReviewPane } = await import('./ReviewPane.tsx');

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

test('on a phone each changed file has a visible ⋯ that opens its menu without a long-press', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const saved = { api: window.mixdogDesktop, raf: globalThis.requestAnimationFrame };
  const userAgent = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent');
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile',
  });
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  window.mixdogRemoteServer = 'wss://relay.example';
  window.mixdogDesktop = {
    gitStatus: async () => ({ repository: true, branch: 'main', ahead: 0, behind: 0, upstream: true, files: [] }),
    gitReview: async () => ({
      repository: true,
      root: '/repo',
      base: 'origin/main',
      files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }],
    }),
    gitReviewDiff: async () => '',
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop = saved.api;
    delete window.mixdogRemoteServer;
    globalThis.requestAnimationFrame = saved.raf;
    delete document.hidden;
    if (userAgent) Object.defineProperty(globalThis.navigator, 'userAgent', userAgent);
    else delete globalThis.navigator.userAgent;
  });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  await act(async () => root.render(React.createElement(ReviewPane, { cwd: '/repo' })));
  await settle();
  const more = host.querySelector('.review-file-header .review-file-more');
  assert.ok(more, 'the ⋯ is drawn on the phone');
  assert.equal(more.getAttribute('aria-label'), 'More actions');
  await act(async () => more.click());
  const items = [...document.querySelectorAll('.review-context-menu [role="menuitem"]')].map(
    (item) => item.textContent
  );
  // OS-only items stay hidden on a remote surface; the file downloads instead.
  assert.deepEqual(items, ['Download / Share', 'Copy path', 'Revert changes']);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
});

// A failed diff read is an error state, not patch text: it must not reach the
// diff renderer, whose fallback would print the message as a raw patch.
test('a failed file diff read renders as an error, never as patch text', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const saved = { api: window.mixdogDesktop, raf: globalThis.requestAnimationFrame };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  // jsdom reports a hidden document, which would keep the refresh paused.
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  window.mixdogDesktop = {
    gitStatus: async () => ({ repository: true, branch: 'main', ahead: 0, behind: 0, upstream: true, files: [] }),
    gitReview: async () => ({
      repository: true,
      root: '/repo',
      base: 'origin/main',
      files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }],
    }),
    gitReviewDiff: async () => {
      throw new Error('git diff failed: bad object');
    },
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop = saved.api;
    globalThis.requestAnimationFrame = saved.raf;
    delete document.hidden;
  });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  await act(async () => root.render(React.createElement(ReviewPane, { cwd: '/repo' })));
  await settle();
  const trigger = host.querySelector('.review-file-trigger');
  assert.ok(trigger, 'the changed file is listed');
  assert.equal(host.querySelector('.review-file-more') === null, true, 'no ⋯ off the phone: right-click owns the menu');
  await act(async () => trigger.click());
  await settle();

  const body = host.querySelector('.review-file-body');
  assert.ok(body);
  // Booleans and text only: inspecting a jsdom node on failure never ends.
  assert.equal(body.querySelector('.diff-fallback') === null, true, 'no raw patch fallback');
  assert.match(body.querySelector('.review-empty')?.textContent ?? '', /bad object/);
});
