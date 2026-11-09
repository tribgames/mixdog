import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createNetworkWatcher, networkSignature } from './network-watch.ts';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the watcher fires on coming back online and on an address change, not on steady state', async () => {
  const state = { online: true, signature: 'a' };
  let fired = 0;
  const watcher = createNetworkWatcher({
    isOnline: () => state.online,
    signature: () => state.signature,
    onChange: () => {
      fired += 1;
    },
    intervalMs: 10,
  });
  try {
    await wait(40);
    assert.equal(fired, 0);
    state.online = false;
    await wait(40);
    assert.equal(fired, 0, 'going offline alone does not redial');
    state.online = true;
    await wait(40);
    assert.equal(fired, 1);
    state.signature = 'b';
    await wait(40);
    assert.equal(fired, 2);
  } finally {
    watcher.stop();
  }
});

test('the signature ignores loopback and is order independent', () => {
  const a = networkSignature({
    eth: [{ address: '10.0.0.2', internal: false }],
    lo: [{ address: '127.0.0.1', internal: true }],
    wifi: [{ address: '192.168.0.5', internal: false }],
  });
  const b = networkSignature({
    wifi: [{ address: '192.168.0.5', internal: false }],
    eth: [{ address: '10.0.0.2', internal: false }],
  });
  assert.equal(a, b);
});
