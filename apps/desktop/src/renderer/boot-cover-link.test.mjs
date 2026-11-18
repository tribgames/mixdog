import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// The first screen's end belongs to the window's own link to its core. A rebuild's counts (even a full bar or a cleared report), the
// readiness of the window and its time limit never open the app while that link is not open; a link that drops during the fade
// takes the hand-off back; and a core that ends at boot the same way each time is a card with a way to try again, not a mark forever.
test('the boot cover stays until the window\'s core link is open, however the boot reports go', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', globals: {} });
  let report;
  window.mixdogCorePort = {
    open: async () => ({ generation: 1 }),
    onBootReport: (listener) => {
      report = listener;
      return () => {};
    },
  };
  window.__mixdogWindowShown = true;
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { watchLocalCoreLink } = await import('./local-core-link.ts');
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const gate = () => document.querySelector('.desktop-boot-gate');
  const cover = () => document.querySelector('.desktop-boot-cover');
  await act(async () =>
    root.render(React.createElement(DesktopBootGate, { ready: true, enabled: true }, React.createElement('main', null, 'app')))
  );
  await wait(350);
  assert.ok(cover(), 'ready, and nothing pending: still covered while the core link is not open');
  assert.equal(gate().getAttribute('data-ready'), 'false');
  assert.equal(document.querySelector('.desktop-loading-progress'), null, 'a normal start draws no bar');

  await act(async () => report({ progress: { done: 3, total: 10 }, failure: null }));
  assert.ok(document.querySelector('.desktop-loading-progress'), 'counts draw the bar');
  await act(async () => report({ progress: { done: 10, total: 10 }, failure: null }));
  await wait(350);
  assert.ok(cover(), '100% does not open the app');
  await act(async () => report({ progress: null, failure: null }));
  await wait(350);
  assert.ok(cover(), 'a cleared report does not open the app');
  assert.equal(document.querySelector('.desktop-loading-progress'), null);

  await act(async () =>
    report({ progress: null, failure: { message: 'core is not ready: the core ended before serving (exited with code 2): mixdogd: no manifest', exitCode: 2, stderrPath: 'C:\\x\\stderr.log' } })
  );
  const card = document.querySelector('.desktop-boot-failure');
  assert.ok(card, 'a start that ends the same way each time is a failure card');
  assert.match(card.querySelector('pre').textContent, /exited with code 2/);
  assert.ok(card.querySelector('button'), 'with a retry');
  assert.equal(document.querySelector('.desktop-boot-cover .window-loading-mark'), null);
  assert.ok(cover(), 'the card is on the cover: the app is not open');

  // The link opens: the existing rules take over and the app opens.
  const listeners = new Set();
  const connection = { status: 'reconnecting', onState: (listener) => (listeners.add(listener), () => listeners.delete(listener)) };
  const move = (status) => act(async () => { connection.status = status; for (const listener of [...listeners]) listener(); });
  watchLocalCoreLink(connection);
  await wait(350);
  assert.ok(cover(), 'a connection that is not ready does not open it');
  await move('ready');
  await wait(60);
  assert.ok(cover()?.getAttribute('data-leaving') === 'true', 'the fade has begun');
  await move('reconnecting');
  await wait(250);
  assert.ok(cover(), 'a link that drops during the fade takes the hand-off back');
  assert.equal(cover().getAttribute('data-leaving'), null);
  await move('ready');
  await wait(350);
  assert.equal(cover(), null, 'once the link is open the readiness rules open the app');
  assert.equal(gate().getAttribute('data-ready'), 'true');
});
