import assert from 'node:assert/strict';
import test from 'node:test';

import { createScreenAccessPublisher } from './screen-access-publisher.ts';

function build() {
  const clients = new Map();
  /** The unpair record (desktop-service: the client cache's queued revokes). */
  const unpaired = new Set();
  const sent = [];
  /** Deliveries wait here until the test lets them through. */
  const deliveries = [];
  let hold = false;
  const publisher = createScreenAccessPublisher({
    client: (clientId) => clients.get(clientId),
    clients: () => clients.entries(),
    unpaired: (credentialId) => unpaired.has(credentialId),
    label: (credentialId) => `device ${credentialId}`,
    send: (clientId, access) => {
      sent.push([clientId, access]);
      return hold ? new Promise((resolve) => deliveries.push(resolve)) : Promise.resolve();
    },
  });
  /** A new connection object under `clientId` (a reused id gets a new one),
   *  admitted as the relay registry does. */
  const connect = (clientId, credentialId, channel = {}) => {
    const client = { credentialId, channel };
    clients.set(clientId, client);
    publisher.admitted(client);
    return client;
  };
  /** desktop-service's order: the unpair is recorded, then the relay revoke starts. */
  const unpair = (credentialId) => {
    unpaired.add(credentialId);
    publisher.revokeCredential(credentialId);
  };
  /** The relay confirmed the revoke, or the device was paired again. */
  const lift = (credentialId) => unpaired.delete(credentialId);
  const deliver = () => {
    for (const resolve of deliveries.splice(0)) resolve();
  };
  return { publisher, clients, sent, connect, unpair, lift, deliver, holdDeliveries: () => (hold = true) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const kinds = (env) => env.sent.map(([clientId, access]) => [clientId, access.paired]);

test('a paired, connected client gets access bound to epoch, revision and its connection', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  assert.equal(env.publisher.allowed('c1', a), true);
  assert.equal(await env.publisher.publish('c1', a), true);
  const [[clientId, access]] = env.sent;
  assert.equal(clientId, 'c1');
  assert.equal(access.paired, true);
  assert.equal(access.label, 'device cred-a');
  assert.ok(access.epoch && access.connection && access.revision >= 1);
});

test('no access before the E2EE channel is established, or without a connection', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a', null);
  assert.equal(env.publisher.allowed('c1', a), false);
  assert.equal(await env.publisher.publish('c1', a), false);
  assert.equal(await env.publisher.publish('c2', a), false);
  assert.deepEqual(env.sent, []);
});

test('regression: a disconnect is denied synchronously, and a grant still in delivery refuses the ready', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  env.holdDeliveries();
  const publishing = env.publisher.publish('c1', a);
  env.clients.delete('c1');
  env.publisher.removed('c1');
  // The deny went out before `removed` returned, with a newer revision, as a
  // departure (not a revocation).
  assert.deepEqual(kinds(env), [
    ['c1', true],
    ['c1', false],
  ]);
  assert.ok(env.sent[1][1].revision > env.sent[0][1].revision);
  assert.equal(env.sent[1][1].ended, 'left');
  env.deliver();
  assert.equal(await publishing, false);
});

test('regression: a ready delivered on a connection the id no longer names is refused, and nothing is sent for it', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  // A's `ready` waits (ICE); A leaves and B takes the id.
  env.clients.delete('c1');
  env.publisher.removed('c1');
  const b = env.connect('c1', 'cred-b');
  assert.equal(env.publisher.allowed('c1', a), false);
  assert.equal(await env.publisher.publish('c1', a), false);
  assert.deepEqual(env.sent, [], 'no grant under B for A’s ready');
  assert.equal(await env.publisher.publish('c1', b), true);
  assert.equal(env.sent.at(-1)[1].label, 'device cred-b');
});

test('regression: a client id reused by another device’s connection never gets the old one’s access', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  env.holdDeliveries();
  const publishing = env.publisher.publish('c1', a);
  // Replaced in the registry: `onRemoved` denies the old connection at once.
  env.clients.delete('c1');
  env.publisher.removed('c1');
  const b = env.connect('c1', 'cred-b');
  env.deliver();
  assert.equal(await publishing, false, 'the old connection’s grant is not current for the new one');
  // The new connection's own grant names a different connection and device.
  const own = env.publisher.publish('c1', b);
  env.deliver();
  assert.equal(await own, true);
  const [, first] = env.sent[0];
  const [, latest] = env.sent.at(-1);
  assert.notEqual(latest.connection, first.connection);
  assert.equal(latest.label, 'device cred-b');
});

test('a connection replaced without a removal still refuses the old ready', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  env.holdDeliveries();
  const publishing = env.publisher.publish('c1', a);
  env.connect('c1', 'cred-a');
  env.deliver();
  assert.equal(await publishing, false);
});

test('regression: an unpaired connection is never granted again, while it stays connected', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  const other = env.connect('c2', 'cred-b');
  assert.equal(await env.publisher.publish('c1', a), true);
  // The relay revoke is still pending: `a` stays in the registry.
  env.unpair('cred-a');
  assert.deepEqual(
    kinds(env),
    [
      ['c1', true],
      ['c1', false],
    ],
    'denied before the unpair returned'
  );
  assert.equal(await env.publisher.publish('c1', a), false);
  assert.equal(env.publisher.allowed('c1', a), false);
  env.lift('cred-a');
  assert.equal(await env.publisher.publish('c1', a), false, 'revoked for the connection’s lifetime');
  assert.deepEqual(
    kinds(env),
    [
      ['c1', true],
      ['c1', false],
    ],
    'the window saw grant, deny, nothing more'
  );
  assert.equal(await env.publisher.publish('c2', other), true, 'another credential is untouched');
});

test('regression: a connection admitted during an unpair and first used after the relay confirmed it is refused', async () => {
  const env = build();
  env.unpair('cred-a');
  // Opened while the revoke is pending; nothing examines it yet.
  const opened = env.connect('c1', 'cred-a', null);
  env.lift('cred-a');
  // Its E2EE channel completes, and it asks, only after the confirmation.
  opened.channel = {};
  assert.equal(env.publisher.allowed('c1', opened), false);
  assert.equal(await env.publisher.publish('c1', opened), false);
  assert.deepEqual(env.sent, []);
});

test('regression: after a failed unpair, a fresh reconnect of that credential is refused', async () => {
  const env = build();
  env.connect('c1', 'cred-a');
  env.unpair('cred-a');
  // The relay revoke failed: the record stays in force. The phone reconnects.
  env.clients.delete('c1');
  env.publisher.removed('c1');
  const fresh = env.connect('c1', 'cred-a');
  assert.equal(env.publisher.allowed('c1', fresh), false);
  assert.equal(await env.publisher.publish('c1', fresh), false);
  const second = env.connect('c2', 'cred-a');
  assert.equal(await env.publisher.publish('c2', second), false);
  assert.deepEqual(env.sent, []);
});

test('the denial lifts for later connections once the relay confirms the unpair or the device is paired again', async () => {
  const env = build();
  const quiet = env.connect('c1', 'cred-a');
  env.unpair('cred-a');
  assert.deepEqual(env.sent, [], 'nothing to deny for a client that never asked');
  const during = env.connect('c2', 'cred-a');
  env.lift('cred-a');
  const later = env.connect('c3', 'cred-a');
  assert.equal(await env.publisher.publish('c3', later), true, 'admitted after the record cleared');
  assert.equal(await env.publisher.publish('c1', quiet), false, 'live at the unpair: refused for good');
  assert.equal(await env.publisher.publish('c2', during), false, 'admitted during it: refused for good');
});

test('unpair denies every connection of the credential synchronously', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  const b = env.connect('c2', 'cred-b');
  await env.publisher.publish('c1', a);
  await env.publisher.publish('c2', b);
  env.unpair('cred-a');
  assert.deepEqual(kinds(env).slice(2), [['c1', false]]);
  assert.equal(env.sent.at(-1)[1].ended, 'revoked');
});

test('a removal of a client that never asked for a screen sends nothing', async () => {
  const env = build();
  env.connect('c1', 'cred-a');
  env.publisher.removed('c1');
  env.unpair('cred-a');
  await flush();
  assert.deepEqual(env.sent, []);
});

test('revisions only grow, across clients and kinds of push', async () => {
  const env = build();
  const a = env.connect('c1', 'cred-a');
  const b = env.connect('c2', 'cred-b');
  await env.publisher.publish('c1', a);
  await env.publisher.publish('c2', b);
  env.publisher.removed('c1');
  await env.publisher.publish('c2', b);
  env.unpair('cred-b');
  const revisions = env.sent.map(([, access]) => access.revision);
  assert.deepEqual(
    revisions,
    [...revisions].sort((x, y) => x - y)
  );
  assert.equal(new Set(revisions).size, revisions.length);
});
