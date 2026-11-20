import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { useDesktopStatus } from './use-desktop-status.ts';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'Event', 'CustomEvent'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

/** A host whose settings read answers with `answer()` and whose settings announcements the test fires. */
function announcingApi(answer) {
  const listeners = new Set();
  return {
    listeners,
    api: {
      readSettings: () => answer(),
      subscribeSettingsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    announce: () =>
      act(async () => {
        for (const listener of [...listeners]) listener({ scope: 'desktop' });
        await new Promise((done) => setTimeout(done, 0));
      }),
  };
}

test('a failed or empty first read stays unknown; every announcement reads again and every consumer follows', async (t) => {
  let answer = () => Promise.reject(new Error('core not ready'));
  const host = announcingApi(() => answer());
  const seenA = [];
  const seenB = [];
  const Probe = ({ seen }) => {
    seen.push(useDesktopStatus(host.api, 'settings'));
    return null;
  };
  const dom = installTestDom(t, DOM);
  await act(async () =>
    dom.root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Probe, { seen: seenA }),
        React.createElement(Probe, { seen: seenB })
      )
    )
  );
  await settle();
  assert.equal(seenA.at(-1), null, 'a failed read is unknown, not a default');

  // No attempt cap: reads that fail, or answer nothing, keep it unknown however often they do.
  for (let i = 0; i < 8; i += 1) {
    answer = i % 2 ? () => Promise.reject(new Error('down')) : () => Promise.resolve(undefined);
    await host.announce();
  }
  assert.equal(seenA.at(-1), null);
  assert.equal(seenB.at(-1), null);

  answer = () => Promise.resolve({ saveChatLogins: false });
  await host.announce();
  assert.deepEqual(seenA.at(-1), { saveChatLogins: false });
  assert.deepEqual(seenB.at(-1), { saveChatLogins: false });

  // A later failure keeps the last known value; a change is followed.
  answer = () => Promise.reject(new Error('blip'));
  await host.announce();
  assert.deepEqual(seenA.at(-1), { saveChatLogins: false });
  answer = () => Promise.resolve({ saveChatLogins: true });
  await host.announce();
  assert.deepEqual(seenA.at(-1), { saveChatLogins: true });
  assert.deepEqual(seenB.at(-1), { saveChatLogins: true });

  await act(async () => dom.root.unmount());
  assert.equal(host.listeners.size, 0, 'unmounting stops following');
});

test('a disabled consumer reads nothing; enabling it reads at once', async (t) => {
  let reads = 0;
  const host = announcingApi(() => {
    reads += 1;
    return Promise.resolve({ keepAwake: true });
  });
  const seen = [];
  const Probe = ({ enabled }) => {
    seen.push(useDesktopStatus(host.api, 'settings', enabled));
    return null;
  };
  const dom = installTestDom(t, DOM);
  await act(async () => dom.root.render(React.createElement(Probe, { enabled: false })));
  await host.announce();
  assert.equal(reads, 0);
  assert.equal(seen.at(-1), null);
  await act(async () => dom.root.render(React.createElement(Probe, { enabled: true })));
  await settle();
  assert.equal(reads, 1);
  assert.deepEqual(seen.at(-1), { keepAwake: true });
});
