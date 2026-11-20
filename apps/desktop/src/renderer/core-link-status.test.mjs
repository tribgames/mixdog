// This PC's own core link: a lost connection reads as Mixdog reconnecting (never as a named remote host), and a link that was
// never ready raises no reconnect notice (the window is starting, not reconnecting).
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx';
import { CORE_LINK_GRACE_MS } from './core-link-store.ts';
import { installTestDom } from './test-support/test-dom.mjs';

function mount(t, first) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
  const listeners = new Set();
  window.mixdogDesktop = {
    connection: { kind: 'local', name: 'MY-PC' },
    sections: {
      snapshot: async () => first,
      subscribe: (next) => {
        listeners.add(next);
        return () => listeners.delete(next);
      },
    },
  };
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  return {
    root,
    push: (status, link) =>
      act(async () => {
        for (const l of listeners) l({ kind: 'status', status, link });
      }),
    toast: () => document.body.querySelector('.conn-link-banner')?.textContent ?? null,
  };
}

const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const LINK = { attempt: 0, closed: null };

test('a lost connection to this PC’s own core does not name the PC', async (t) => {
  const host = mount(t, { status: 'ready', link: LINK });
  await act(async () => host.root.render(React.createElement(ConnectionStatusBanner)));
  await wait(0);
  await host.push('reconnecting', LINK);
  assert.equal(host.toast(), null, 'not shown before the grace');
  await wait(CORE_LINK_GRACE_MS + 200);
  assert.match(host.toast(), /Reconnecting \(attempt 1\)/);
  assert.doesNotMatch(host.toast(), /MY-PC/);
  assert.doesNotMatch(host.toast(), /Mixdog/);
  await host.push('closed', { attempt: 1, closed: { cause: 'failed', message: 'x' } });
  assert.match(host.toast(), /Connection lost/);
  assert.doesNotMatch(host.toast(), /MY-PC/);
  assert.doesNotMatch(host.toast(), /Mixdog/);
});

test('a link that was never ready raises no reconnect notice', async (t) => {
  const host = mount(t, { status: 'reconnecting', link: LINK });
  await act(async () => host.root.render(React.createElement(ConnectionStatusBanner)));
  await wait(CORE_LINK_GRACE_MS + 200);
  assert.equal(host.toast(), null);
});
