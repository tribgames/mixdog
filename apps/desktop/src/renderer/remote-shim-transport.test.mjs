// The phone's transport through `createRelayConnector` alone (mobile/src/relay-connector.ts over shared/remote-transport.ts) on the
// scripted phone world: no client, view or app. What the phone sends reaches the desktop as numbered records; what the desktop sends is
// delivered in order; the phone acknowledges the desktop's records cumulatively within the ack delay (remote-transport.ts\n// REMOTE_TRANSPORT_MAX_ACK_DELAY_MS, ackDue).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REMOTE_TRANSPORT_MAX_ACK_DELAY_MS } from '../shared/remote-transport.ts';
import { createPhoneWorld, protocolDialect } from './test-support/phone-world.mjs';

test('records out are numbered, frames in are delivered in order, and acks are cumulative within the ack delay', async () => {
  const repo = new URL('../../../../', import.meta.url);
  const options = JSON.parse(readFileSync(new URL('packages/protocol-client/conformance/options.json', repo), 'utf8'));
  const world = await createPhoneWorld({
    tree: fileURLToPath(repo),
    dialect: protocolDialect({ ...options.initializeResult, serverVersion: '0.0.0' }),
    mxt: true,
    installed: false,
  });
  const { createRelayConnector } = await import('../../../mobile/src/relay-connector.ts');
  const visible = () => globalThis.document.visibilityState !== 'hidden';
  const connector = createRelayConnector({
    pairing: () => world.material,
    socketUrl: () => 'wss://relay.test/ws',
    createSocket: (url) => new globalThis.WebSocket(url),
    ready: () => world.log({ ev: 'ready' }),
    visible,
    webrtc: { createPeer: (configuration) => new globalThis.RTCPeerConnection(configuration), visible, log: () => {} },
  });
  let writer;
  void connector
    .open({ id: 'pc' }, { frame: (text) => world.log({ ev: 'deliver', frame: JSON.parse(text) }), closed: () => {} })
    .then((w) => (writer = w));
  await world.waitFor((e) => e.ev === 'socket');
  const socket = await world.accept({ transportWebrtc: 1, binaryFrames: 1 });
  await world.until(() => world.events.some((e) => e.ev === 'ready'));
  await world.advance(0);
  const records = () => world.events.filter((e) => e.ev === 'xrecord').map((e) => e.seq);

  writer.send(JSON.stringify({ n: 1 }));
  writer.send(JSON.stringify({ n: 2 }));
  await world.advance(0);
  assert.deepEqual(records(), [1, 2].map((n) => records()[n - 1]), 'two records reached the desktop');
  assert.equal(records().length, 2);
  assert.equal(records()[1], records()[0] + 1, 'consecutive sequence numbers');

  const through = () => world.events.filter((e) => e.ev === 'xcontrol' && e.kind === 'ack').map((e) => Number(e.control.through)).at(-1) ?? 0;
  const unacked = [];
  // The desktop's records are acknowledged cumulatively: each record is covered by an ack within the ack delay.
  await world.legOf(socket).toPhone({ n: 'a' });
  await world.advance(REMOTE_TRANSPORT_MAX_ACK_DELAY_MS);
  const base = through();
  assert.ok(base >= 1, 'the first record is acknowledged within the ack delay');
  for (const n of ['b', 'c', 'd']) {
    await world.legOf(socket).toPhone({ n });
    unacked.push(n);
    await world.advance(REMOTE_TRANSPORT_MAX_ACK_DELAY_MS);
    assert.equal(through(), base + unacked.length, `record ${n} is acknowledged, cumulatively, within the ack delay`);
  }
  const heard = world.events.filter((e) => e.ev === 'xcontrol' && e.kind === 'ack').map((e) => Number(e.control.through));
  assert.deepEqual(heard, [...heard].sort((a, b) => a - b), 'acks never go backwards');
  assert.deepEqual(world.events.filter((e) => e.ev === 'deliver').map((e) => e.frame.n), ['a', 'b', 'c', 'd']);
});