import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { useConnectionsCore } from './test-support/connections-core-mock.mjs';

const { ConnectionStatusBanner } = await import('./ConnectionStatusBanner.tsx');

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'MutationObserver'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

function localApi(snapshot) {
  const reconnects = [];
  return {
    reconnects,
    connection: { kind: 'local', id: 'local', name: 'this-pc' },
    getServerRestoreProgress: () => Promise.resolve([]),
    subscribeServerRestoreProgress: () => () => undefined,
    subscribeConnectionSignIn: () => () => undefined,
    sections: {
      subscribe: () => () => undefined,
      snapshot: () => Promise.resolve({ entries: [], ...snapshot }),
      reconnect: () => (reconnects.push(true), Promise.resolve()),
    },
  };
}

test('a closed connection to this PC’s own core says why and offers Reconnect, and the composer takes no input', async (t) => {
  const dom = installTestDom(t, DOM);
  const api = localApi({ status: 'closed', link: { attempt: 0, closed: { cause: 'clientOutdated', message: '' } } });
  dom.window.mixdogDesktop = api;
  useConnectionsCore(api);
  globalThis.window = dom.window;
  await act(async () => dom.root.render(React.createElement(ConnectionStatusBanner)));
  await settle();
  const banner = dom.document.querySelector('.conn-link-banner');
  assert.ok(banner, 'a window on its own core shows the loss');
  assert.match(banner.textContent, /Connection lost/);
  assert.doesNotMatch(banner.textContent, /this-pc|Mixdog/);
  assert.match(banner.textContent, /older than the version running on the server\. Update the app/);
  assert.equal(dom.document.documentElement.dataset.connectionDown, 'true');
  const reconnect = [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Reconnect');
  assert.ok(reconnect);
  await act(async () => reconnect.click());
  assert.deepEqual(api.reconnects, [true]);
});

test('a core that is up shows nothing', async (t) => {
  const dom = installTestDom(t, DOM);
  const api = localApi({ status: 'ready', link: { attempt: 0, closed: null } });
  dom.window.mixdogDesktop = api;
  useConnectionsCore(api);
  globalThis.window = dom.window;
  await act(async () => dom.root.render(React.createElement(ConnectionStatusBanner)));
  await settle();
  assert.equal(dom.document.querySelector('.conn-link-banner'), null);
});
