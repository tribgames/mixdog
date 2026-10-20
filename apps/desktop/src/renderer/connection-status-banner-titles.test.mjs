import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'MutationObserver'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

test('the re-attach notice names an attachment-only session by its kind, not [Image]', async (t) => {
  const dom = installTestDom(t, DOM);
  const listeners = new Set();
  dom.window.mixdogDesktop = {
    connection: { kind: 'ssh', id: 'h1', name: 'vps' },
    subscribeConnectionLink: () => () => undefined,
    subscribeConnectionNotice: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getConnectionLink: () => Promise.resolve({ state: { status: 'connected' } }),
  };
  globalThis.window = dom.window;
  await act(async () => dom.root.render(React.createElement(ConnectionStatusBanner)));
  await settle();
  await act(async () => {
    for (const listener of listeners)
      listener({ kind: 'reattached', finished: ['[Image]', 'Build'], continued: ['[File]'], interruptedModelCalls: 0 });
  });
  const text = dom.document.querySelector('.conn-link-notice').textContent;
  assert.match(text, /Finished on the server while away: Image, Build/);
  assert.match(text, /Still running on the server: File/);
  assert.doesNotMatch(text, /\[(?:Image|File)\]/);
});
