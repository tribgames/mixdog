import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { ConnectionStatusBanner } from './ConnectionStatusBanner.tsx';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'MutationObserver'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

test('a server window’s lost-connection banner has "View log" and opens its own server’s log', async (t) => {
  const dom = installTestDom(t, DOM);
  const refs = [];
  dom.window.mixdogDesktop = {
    connection: { kind: 'ssh', id: 'h1', name: 'vps' },
    subscribeConnectionLink: () => () => undefined,
    subscribeConnectionNotice: () => () => undefined,
    getConnectionLink: () => Promise.resolve({ state: { status: 'lost', code: 'unreachable', message: 'gone' } }),
    sshDiagnosticsLog: (ref) => (
      refs.push(ref), Promise.resolve({ lines: ['12:00:00.000 tunnel exited code 255 after 40 ms'], copyText: '' })
    ),
    sshServerLog: () => Promise.resolve({ ok: true, text: 'daemon.log tail', copyText: 'daemon.log tail' }),
  };
  globalThis.window = dom.window;
  await act(async () => dom.root.render(React.createElement(ConnectionStatusBanner)));
  await settle();
  const button = [...dom.document.querySelectorAll('.conn-link-actions button')].find(
    (b) => b.textContent === 'View log'
  );
  assert.ok(button, 'the reserved slot holds the button');
  await act(async () => button.click());
  await settle();
  assert.deepEqual(refs, [''], 'a server window passes no reference; main answers with its own server');
  assert.match(dom.document.querySelector('pre.ssh-log').textContent, /tunnel exited code 255/);
  const labels = [...dom.document.querySelectorAll('.conn-dialog footer button')].map((b) => b.textContent);
  assert.deepEqual(labels, ['Fetch server log', 'Copy diagnostics', 'Copy', 'Close']);
});
