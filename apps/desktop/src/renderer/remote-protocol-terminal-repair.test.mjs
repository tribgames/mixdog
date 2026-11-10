// A re-pairing in the same page dials a new protocol client (phone-boot.ts: `pairing-lost` drops the client, the approval's dial makes another);
// Node's relay pushed to whichever connection was current (remote-relay-push-lanes.ts:64). The terminal adapter reads the events of the
// client that is up and moves to each replacement: output on the new client reaches the page, the revoked client's reaches nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-terminal.ts';
import { bounded } from './remote-protocol-terminal-deadlines.mjs';

/** A protocol client as far as the adapter reads it: its notifications and its (empty) held sections. */
function client() {
  const listeners = new Set();
  let heard;
  // Resolves when the adapter starts reading this client's notifications.
  const read = new Promise((resolve) => (heard = resolve));
  return {
    read,
    on: (listener) => (listeners.add(listener), heard(), () => listeners.delete(listener)),
    store: { section: () => null, subscribe: () => () => undefined },
    server: { platformOs: 'windows' },
    output: (id, text) => {
      const notification = { method: 'process/outputDelta', params: { bytesB64: Buffer.from(text).toString('base64') }, feed: { id: `process:relay:${id}` } };
      for (const listener of [...listeners]) listener({ type: 'notification', notification });
    },
  };
}

test('after a re-pairing the terminal output of the new client reaches the page and the revoked client is not read', async () => {
  const heard = [];
  const ctx = {
    activeLanes: new Set(['terminal']),
    termListeners: new Set([(event) => heard.push(event)]),
    termActivityListeners: new Set(),
    termSizeOwnerListeners: new Set(),
    folderChangeListeners: new Set(),
    terminalRunListeners: new Set(),
    fanOut: (listeners, value) => {
      for (const listener of listeners) listener(value);
    },
    phone: { start: async () => undefined },
  };
  const clients = new Set();
  let current = null;
  const host = {
    ctx,
    client: () => current,
    declareLane: () => undefined,
    onClient: (listener) => (clients.add(listener), () => clients.delete(listener)),
  };
  const up = (next) => {
    current = next;
    for (const listener of [...clients]) listener(next);
  };
  const stop = adapter.install(host);
  const revoked = client();
  up(revoked);
  await bounded(revoked.read, 'the adapter to read the first client');
  revoked.output('term_a', 'before');
  const approved = client();
  up(approved);
  await bounded(approved.read, 'the adapter to read the client of the new pairing');
  revoked.output('term_a', 'from the revoked client');
  approved.output('term_b', 'after');
  assert.deepEqual(heard, [
    { id: 'term_a', data: 'before' },
    { id: 'term_b', data: 'after' },
  ]);
  stop();
  approved.output('term_b', 'after the teardown');
  assert.equal(heard.length, 2, 'the teardown stops reading the current client');
});
