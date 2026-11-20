import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DesktopLoadingSurface } from './RendererRecovery.tsx';
import { createBootReportStore } from './boot-progress.ts';

// The first screen while the core rebuilds its conversation index: the mark, and under it a thin bar that fills with the
// sessions done. A normal start (nothing reported) is the mark alone.
test('the boot cover draws the rebuild bar only while progress is reported, filled to done of total, with no text', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'Event'],
  });
  const { document } = dom.window;
  const root = createRoot(document.getElementById('root'));
  const render = (progress) =>
    act(async () => {
      root.render(React.createElement(DesktopLoadingSurface, { label: 'Starting Mixdog…', brand: true, progress }));
    });

  await render(undefined);
  assert.ok(document.querySelector('.window-loading-mark'), 'the mark');
  assert.equal(document.querySelector('.desktop-loading-progress'), null, 'a normal start has no bar');

  await render({ done: 250, total: 1000 });
  const bar = document.querySelector('.desktop-loading-progress');
  assert.ok(bar, 'the bar');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-label'), 'Organizing your conversation history');
  assert.equal(bar.getAttribute('aria-valuenow'), '250');
  assert.equal(bar.getAttribute('aria-valuemax'), '1000');
  assert.equal(document.querySelector('.desktop-loading-progress-fill').style.width, '25%');
  assert.equal(bar.textContent, '', 'no text on screen');
  assert.ok(document.querySelector('.window-loading-mark'), 'the mark stays');

  await render({ done: 1000, total: 1000 });
  assert.equal(document.querySelector('.desktop-loading-progress-fill').style.width, '100%');

  await render(null);
  assert.equal(document.querySelector('.desktop-loading-progress'), null, 'the bar goes with the progress');

  await act(async () => root.unmount());
});

test('the boot report store follows the window bridge: counts only when they count something, a failure only with its sentence', () => {
  let report;
  const store = createBootReportStore({
    onBootReport: (listener) => {
      report = listener;
      return () => {};
    },
  });
  let told = 0;
  store.subscribe(() => {
    told += 1;
  });
  assert.deepEqual(store.get(), { progress: null, failure: null }, 'nothing before a report');
  report({ progress: { done: 3, total: 10 }, failure: null });
  assert.deepEqual(store.get().progress, { done: 3, total: 10, boot: null });
  report({ progress: { done: 99, total: 10 }, failure: null });
  assert.deepEqual(store.get().progress, { done: 10, total: 10, boot: null }, 'never past the total');
  report({ progress: { done: 4, total: 10, boot: 1 }, failure: null });
  report({ progress: { done: 2, total: 10, boot: 1 }, failure: null });
  assert.equal(store.get().progress.done, 4, "one boot's counts never go back");
  report({ progress: null, failure: null });
  report({ progress: { done: 3, total: 10, boot: 1 }, failure: null });
  assert.equal(store.get().progress.done, 4, 'withdrawing the bar does not forget the highest count of the boot');
  report({ progress: { done: 0, total: 10, boot: 2 }, failure: null });
  assert.equal(store.get().progress.done, 0, 'a new boot starts again');
  report({ progress: { done: 8, total: 10, boot: 1 }, failure: null });
  assert.deepEqual(
    store.get().progress,
    { done: 0, total: 10, boot: 2 },
    "a superseded boot's late report changes nothing"
  );
  report({ progress: { done: 0, total: 0 }, failure: null });
  assert.equal(store.get().progress, null, 'a migration without counts is the mark alone');
  report({ progress: null, failure: { message: 'the core ended', exitCode: 2, stderrPath: null } });
  assert.deepEqual(store.get().failure, { message: 'the core ended', exitCode: 2, stderrPath: null });
  report({ progress: null, failure: { message: '' } });
  assert.equal(store.get().failure, null);
  assert.equal(told, 11);
  assert.deepEqual(
    createBootReportStore(undefined).get(),
    { progress: null, failure: null },
    'a window without the bridge (a phone) has none'
  );
});
