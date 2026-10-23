// A server window whose models run with the server's own logins shows
// "Server account" beside the model name; on this PC's logins it shows nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';

test('the composer marks a server window running on the server’s own logins', async (t) => {
  const dom = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'Node', 'Event'] });
  const listeners = new Set();
  const view = (modelLogin) => ({
    connectionId: 'srv',
    state: { status: 'connected' },
    rttMs: 12,
    terminalsAvailable: true,
    modelLogin,
  });
  dom.window.mixdogDesktop = {
    connection: { id: 'srv', kind: 'ssh', name: 'build-box' },
    getConnectionLink: () => Promise.resolve(view('server')),
    subscribeConnectionLink: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const { ServerAccountBadge } = await import('./ComposerFooter.tsx');
  await act(async () => dom.root.render(React.createElement(ServerAccountBadge)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const badge = () => dom.document.querySelector('.composer-server-account');
  assert.equal(badge()?.textContent, 'Server account');
  await act(async () => {
    for (const listener of listeners) listener(view('pc'));
  });
  assert.equal(badge(), null, "this PC's logins: no badge");
});
