import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'MutationObserver'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

test('a server window’s notices are information only: a sign-in notice has no action and can be dismissed', async (t) => {
  const dom = installTestDom(t, DOM);
  const listeners = new Set();
  dom.window.mixdogDesktop = {
    connection: { kind: 'ssh', id: 'h1', name: 'vps' },
    subscribeConnectionLink: () => () => undefined,
    subscribeConnectionNotice: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    getConnectionLink: () => Promise.resolve({ state: { status: 'connected' } }),
  };
  globalThis.window = dom.window;
  await act(async () => dom.root.render(React.createElement(ConnectionStatusBanner)));
  await settle();
  const notify = () =>
    act(async () => {
      for (const listener of listeners) listener({ kind: 'model-sign-in', provider: 'openai' });
    });
  const notice = () => dom.document.querySelector('.conn-link-notice');

  await notify();
  assert.match(notice().textContent, /model sign-in has expired/);
  assert.deepEqual(
    [...notice().querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ['Dismiss'],
    'only the dismiss control: no Keep allowing'
  );
  await act(async () => notice().querySelector('button').click());
  assert.equal(notice(), null);
});
