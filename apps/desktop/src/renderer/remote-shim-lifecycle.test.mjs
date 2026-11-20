// The phone shim's connection lifecycle through the protocol client, on the scripted phone world: the first connect reaches the
// connected state; a revoked pairing (relay close 4003) is terminal: the page is told once, the stored credential goes, and no
// socket is opened again. One world per file (the shim keeps module-level state), so the story runs in one test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapterWorld } from './phone-adapter-world.mjs';

test('connect, then a revoked pairing ends the connection for good', async () => {
  const { world } = await adapterWorld();
  const states = () => world.events.filter((e) => e.ev === 'state').map((e) => e.state);
  await world.until(() => states().includes('connected'));
  assert.equal(
    world.events.some((e) => e.ev === 'pairing-invalid'),
    false
  );
  assert.equal(world.sockets.length, 1);

  world.peerClose(world.sockets[0], 4003, 'revoked');
  await world.until(() => world.events.some((e) => e.ev === 'pairing-invalid'));
  const invalid = world.events.filter((e) => e.ev === 'pairing-invalid');
  assert.equal(invalid.length, 1);
  assert.equal(typeof invalid[0].message, 'string');
  assert.ok(invalid[0].message.length > 0, 'the page is given a message to show');

  // Past every backoff step the shim opens no further socket.
  await world.advance(70_000);
  assert.equal(world.sockets.length, 1);
  assert.equal(world.events.filter((e) => e.ev === 'pairing-invalid').length, 1);
});
