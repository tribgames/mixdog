import test from 'node:test';
import assert from 'node:assert/strict';

import { webcrypto } from 'node:crypto';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
  RELAY_E2EE_RELAY_LANE as RELAY,
} from './remote-e2ee';

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64u = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const lane = (epoch, connectionId = `conn-${epoch}`) => ({ kind: 'direct', epoch, connectionId });
/** Authorizes and activates a direct lane on both ends, as signaling does. */
function promote(sides, direct) {
  for (const side of sides) {
    side.registerControlLane(direct);
    side.activateControlLane(direct);
  }
}
const ready = (server) => ({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() });

/** The browser's real hello extras (renderer/remote-shim-socket.ts). */
const HELLO_FIELDS = { viewSync: 1, promptHistoryPatch: 2 };

async function session({ offer = true, accept = true, binary = true } = {}) {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = {
    ...createRelayE2EEChallenge(),
    ...(binary ? { binaryFrames: 1 } : {}),
    ...(offer ? { transportWebrtc: 1 } : {}),
  };
  const client = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge, {
    transportWebrtc: accept,
    helloFields: HELLO_FIELDS,
  });
  const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
  client.channel.confirmHandshake(ready(server));
  return { client: client.channel, server, hello: client.hello };
}

/** Independent oracle for the legacy wire: the legacy channel key derived
 *  straight from the spec (ECDH → HKDF info `…\0key\0…`), never through the
 *  module under test. */
async function legacyOracleKey(identity, challenge, clientPublicKey) {
  const privateKey = await subtle.importKey('jwk', identity.privateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = await subtle.importKey('raw', fromB64u(clientPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fromB64u(identity.pairingSecret),
      info: enc.encode(`mixdog-relay-e2ee-v1\0key\0${challenge}\0${identity.serverPublicKey}\0${clientPublicKey}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

test('neither side offering: hello, proof, e2ee-ready and boxes are the legacy ones byte for byte', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, deflate: 1 };
  for (const options of [undefined, { transportWebrtc: false }]) {
    const { hello, channel } = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge, options);
    assert.deepEqual(Object.keys(hello), ['type', 'version', 'challenge', 'clientPublicKey', 'proof', 'binaryFrames', ...(hello.deflate ? ['deflate'] : [])]);
    // The proof is the legacy HMAC over the legacy payload.
    const hmac = await subtle.importKey('raw', fromB64u(identity.pairingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = await subtle.sign('HMAC', hmac, enc.encode(`mixdog-relay-e2ee-v1\0hello\0${challenge.challenge}\0${identity.serverPublicKey}\0${hello.clientPublicKey}`));
    assert.equal(hello.proof, b64u(new Uint8Array(expected)));
    const server = await acceptRelayE2EEClientHello(identity, challenge, hello);
    assert.deepEqual(server.handshakeConfirmation(), {}, 'e2ee-ready gains nothing');
    // A client box opens under the independently derived legacy key and AAD.
    const box = await channel.encryptBinary({ method: 'ping' });
    const key = await legacyOracleKey(identity, challenge.challenge, hello.clientPublicKey);
    const view = new DataView(box.buffer);
    assert.equal(view.getBigUint64(4, false), 1n);
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: box.slice(12, 24), additionalData: enc.encode('mixdog-relay-e2ee-v1\0client-to-server\x001') },
      key,
      box.slice(24)
    );
    assert.equal(new TextDecoder().decode(plaintext), '{"method":"ping"}');
    assert.deepEqual(await server.decryptJson(box), { method: 'ping' });
  }
});

test('downgrade: a relay stripping the transport OFFER is caught by the client confirmation', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  for (const tamper of [
    (c) => { delete c.transportWebrtc; },
    (c) => { delete c.binaryFrames; },
    (c) => { c.transportWebrtc = 2; },
  ]) {
    const seen = { ...challenge };
    tamper(seen);
    const client = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), seen, { transportWebrtc: true });
    assert.equal(client.hello.transportWebrtc, undefined, 'the client was led to the legacy path');
    // The server takes it as an older browser (authenticated legacy proof)...
    const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
    assert.equal(server.transportEnabled, false);
    // ...but its authenticated e2ee-ready names the transcript it offered.
    assert.throws(() => client.channel.confirmHandshake(ready(server)), /transcript mismatch/);
    await assert.rejects(() => client.channel.encryptBinary({ method: 'listProjects' }), /not confirmed/);
  }
});

test('downgrade: stripping or altering the SELECTION fails the handshake at the server', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  const client = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge, {
    transportWebrtc: true,
    helloFields: HELLO_FIELDS,
  });
  assert.equal(client.hello.transportWebrtc, 1);
  const variants = [
    (h) => { delete h.transportWebrtc; },
    (h) => { delete h.binaryFrames; },
    (h) => { delete h.viewSync; },
    (h) => { h.deflate = 1; },
  ];
  for (const tamper of variants) {
    const hello = { ...client.hello };
    tamper(hello);
    await assert.rejects(() => acceptRelayE2EEClientHello(identity, challenge, hello), /authentication failed/);
  }
  // A selection injected into an older browser's hello fails as well.
  const old = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge);
  await assert.rejects(
    () => acceptRelayE2EEClientHello(identity, challenge, { ...old.hello, transportWebrtc: 1 }),
    /authentication failed/
  );
  // And a selection answering a challenge that never offered it.
  const plain = { ...createRelayE2EEChallenge(), binaryFrames: 1 };
  const injected = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), { ...plain, transportWebrtc: 1 }, { transportWebrtc: true });
  await assert.rejects(() => acceptRelayE2EEClientHello(identity, plain, injected.hello), /authentication failed/);
  // binaryFrames flipped ON for the client by the relay: the client selects
  // transport, the host that offered it without binary frames refuses.
  const noBinary = { ...createRelayE2EEChallenge(), transportWebrtc: 1 };
  const flipped = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), { ...noBinary, binaryFrames: 1 }, { transportWebrtc: true });
  assert.equal(flipped.hello.transportWebrtc, 1);
  await assert.rejects(() => acceptRelayE2EEClientHello(identity, noBinary, flipped.hello), /authentication failed/);
  // Untouched, it completes and confirms.
  const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
  assert.equal(server.transportEnabled, true);
  client.channel.confirmHandshake(ready(server));
  assert.deepEqual(await server.decryptJson(await client.channel.encryptBinary({ ok: 1 })), { ok: 1 });
});

test('compatibility paths are explicit: an older host confirms by offering nothing; an older browser is served legacy', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  // New browser, host that offers nothing: its e2ee-ready carries no transcript.
  const plain = { ...createRelayE2EEChallenge(), binaryFrames: 1 };
  const browser = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), plain, { transportWebrtc: true });
  await assert.rejects(() => browser.channel.encryptBinary({ early: 1 }), /not confirmed/);
  const host = await acceptRelayE2EEClientHello(identity, plain, browser.hello);
  browser.channel.confirmHandshake(ready(host));
  assert.deepEqual(await host.decryptJson(await browser.channel.encryptBinary({ ok: 1 })), { ok: 1 });
  // A transcript that does not match is refused even on that path.
  const again = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), plain, { transportWebrtc: true });
  assert.throws(() => again.channel.confirmHandshake({ type: 'e2ee-ready', transcript: 'A'.repeat(43) }), /transcript mismatch/);
  // Older browser (no opt-in) against an offering host: legacy session, no confirmation needed.
  const offering = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  const older = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), offering);
  const served = await acceptRelayE2EEClientHello(identity, offering, older.hello);
  assert.equal(served.transportEnabled, false);
  assert.ok(served.handshakeConfirmation().transcript);
  assert.deepEqual(await served.decryptJson(await older.channel.encryptBinary({ ok: 2 })), { ok: 2 });
});

test('legacy sessions stay legacy: no echo, no control domain, legacy boxes interoperate', async () => {
  for (const options of [{ offer: false }, { accept: false }, { binary: false }]) {
    const { client, server, hello } = await session(options);
    assert.equal(hello.transportWebrtc, undefined);
    assert.equal(client.transportEnabled, false);
    assert.equal(server.transportEnabled, false);
    const box = await client.encryptBinary({ method: 'ping' });
    assert.deepEqual(await server.decryptJson(box), { method: 'ping' });
    await assert.rejects(() => server.decryptJson(box), /replayed/);
    await assert.rejects(() => client.sealControl({ t: 'ping' }, RELAY), /no transport control domain/);
  }
  // The legacy two-argument call is unchanged.
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  const legacy = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge);
  assert.equal(legacy.hello.transportWebrtc, undefined);
  assert.equal((await acceptRelayE2EEClientHello(identity, challenge, legacy.hello)).transportEnabled, false);
});

test('a transport session encrypts the app domain with directional keys', async () => {
  const { client, server, hello } = await session();
  assert.equal(hello.transportWebrtc, 1);
  assert.equal(client.transportEnabled, true);
  const up = await client.encryptBinary({ a: 1 });
  assert.deepEqual(await server.decryptJson(up), { a: 1 });
  const down = await server.encryptBinary({ b: 2 });
  assert.deepEqual(await client.decryptJson(down), { b: 2 });
  // Reflected back to its own sender: the direction key differs.
  const again = await client.encryptBinary({ c: 3 });
  await assert.rejects(() => client.decryptJson(again));
});

test('control and app domains reject each other’s records (cross-domain replay)', async () => {
  const { client, server } = await session();
  const control = await client.sealControl({ t: 'ping', id: 1 }, RELAY);
  const app = await client.encryptBinary({ t: 'ping', id: 1 });
  // A control box re-labelled as an app box, and an app box re-labelled as control.
  const asApp = control.slice();
  asApp.set([0x4d, 0x58, 0x45, 0x01], 0);
  await assert.rejects(() => server.decryptJson(asApp));
  const asControl = app.slice();
  asControl.set([0x4d, 0x58, 0x43, 0x01], 0);
  await assert.rejects(() => server.openControl(asControl, RELAY));
  // The genuine records still open in their own domain afterwards.
  assert.deepEqual(await server.decryptJson(app), { t: 'ping', id: 1 });
  assert.deepEqual(await server.openControl(control, RELAY), { stale: false, sequence: 1, value: { t: 'ping', id: 1 } });
});

test('control domain: replay is checked per FIFO lane; lanes are independent', async () => {
  const { client, server } = await session();
  const A = lane(1, 'conn-a');
  promote([client, server], A);
  const onA = [];
  const onRelay = [];
  for (let index = 1; index <= 3; index += 1) {
    onRelay.push(await client.sealControl({ r: index }, RELAY));
    onA.push(await client.sealControl({ a: index }, A));
  }
  // Within one lane, a repeat or anything at or below its high-water is stale.
  assert.deepEqual(await server.openControl(onA[1], A), { stale: false, sequence: 4, value: { a: 2 } });
  assert.deepEqual(await server.openControl(onA[1], A), { stale: true, sequence: 4 });
  assert.deepEqual(await server.openControl(onA[0], A), { stale: true, sequence: 2 });
  // The other lane has its own high-water: the relay boxes A overtook still open.
  assert.deepEqual(await server.openControl(onRelay[0], RELAY), { stale: false, sequence: 1, value: { r: 1 } });
  assert.deepEqual(await server.openControl(onA[2], A), { stale: false, sequence: 6, value: { a: 3 } });
  assert.deepEqual(await server.openControl(onRelay[2], RELAY), { stale: false, sequence: 5, value: { r: 3 } });
  // Concurrent opens on one lane run in call order, so none races the high-water.
  const more = [];
  for (let index = 0; index < 20; index += 1) more.push(await client.sealControl({ m: index }, A));
  const opened = await Promise.all(more.map((box) => server.openControl(box, A)));
  assert.deepEqual(opened.map((result) => result.stale), more.map(() => false));
  // Concurrent seals resolve in sequence order.
  const resolved = [];
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      client.sealControl({ s: index, pad: 'p'.repeat((20 - index) * 2000) }, RELAY).then((box) => {
        resolved.push(Number(new DataView(box.buffer, box.byteOffset).getBigUint64(4, false)));
      })
    )
  );
  assert.deepEqual(resolved, [...resolved].sort((a, b) => a - b));
  // Tampered ciphertext throws rather than reading as stale; so does a bad lane.
  const forged = (await client.sealControl({ f: 1 }, RELAY)).slice();
  forged[forged.length - 1] ^= 1;
  await assert.rejects(() => server.openControl(forged, RELAY));
  await assert.rejects(() => server.openControl(onA[2], 'relay'), /lane/);
  await assert.rejects(() => server.openControl(onA[2], { kind: 'direct', epoch: 0, connectionId: 'x' }), /lane/);
  // Another session's control box never opens here.
  const other = await session();
  const foreign = await other.client.sealControl({ n: 9 }, RELAY);
  const fresh = await session();
  await assert.rejects(() => fresh.server.openControl(foreign, RELAY));
  assert.deepEqual(await other.server.openControl(foreign, RELAY), { stale: false, sequence: 1, value: { n: 9 } });
});

test('control lanes are authenticated: a box sealed for one lane or epoch never opens on another', async () => {
  const { client, server } = await session();
  const A = lane(1, 'conn-a');
  const B = lane(2, 'conn-b');
  promote([client, server], A);
  for (const side of [client, server]) side.registerControlLane(B); // B pending
  // The relay probe: one sequence-1 box offered as every lane.
  const box = await client.sealControl({ t: 'ping', id: 1 }, RELAY);
  await assert.rejects(() => server.openControl(box, A), 'relay box on the current direct lane');
  await assert.rejects(() => server.openControl(box, B), 'relay box on the pending direct lane');
  assert.equal((await server.openControl(box, RELAY)).stale, false);
  // A direct box on the relay, on the other connection, or with the other epoch.
  const direct = await client.sealControl({ t: 'ping', id: 2 }, A);
  await assert.rejects(() => server.openControl(direct, RELAY));
  await assert.rejects(() => server.openControl(direct, B));
  // An unregistered lane at or below the epoch floor reads as retired: stale, never opened.
  assert.equal((await server.openControl(direct, lane(2, 'conn-a'))).stale, true);
  assert.equal((await server.openControl(direct, A)).stale, false);
  // A lane never authorized cannot be sealed for or opened.
  await assert.rejects(() => client.sealControl({}, lane(9, 'conn-z')), /not registered/);
  await assert.rejects(() => server.openControl(direct, lane(9, 'conn-z')), /not registered/);
});

test('replay on a retired connection is stale, and the retired epoch can never be registered again', async () => {
  const { client, server } = await session();
  const A = lane(1, 'conn-a');
  const B = lane(2, 'conn-b');
  promote([client, server], A);
  const late = await client.sealControl({ t: 'ack', through: 1 }, A);
  const early = await client.sealControl({ t: 'ack', through: 0 }, A);
  assert.equal((await server.openControl(early, A)).stale, false);
  // B replaces A (promotion of a new connection retires the old one).
  promote([client, server], B);
  assert.deepEqual(await server.openControl(late, A), { stale: true, sequence: 1 }, 'a late genuine box is harmless');
  assert.deepEqual(await server.openControl(early, A), { stale: true, sequence: 2 }, 'a replay on the retired lane');
  await assert.rejects(() => client.sealControl({}, A), /retired/);
  // Re-registering the retired epoch (or any epoch at or below the floor) fails.
  assert.throws(() => server.registerControlLane(A), /retired/);
  assert.throws(() => server.registerControlLane(lane(2, 'conn-other')), /retired/);
  assert.throws(() => server.registerControlLane(lane(1, 'conn-new')), /retired/);
  // An explicit retire (connection closed) is final too.
  server.retireControlLane(B);
  assert.equal((await server.openControl(await client.sealControl({}, B), B)).stale, true);
  assert.throws(() => server.registerControlLane(B), /retired/);
  assert.throws(() => server.activateControlLane(lane(3)), /not pending/);
  assert.throws(() => server.registerControlLane(RELAY), /direct/);
});

test('connection churn keeps the lane table bounded and rejects every old epoch', async () => {
  const { client, server } = await session();
  let previous = null;
  for (let epoch = 1; epoch <= 1_000; epoch += 1) {
    const next = lane(epoch);
    for (const side of [client, server]) side.registerControlLane(next);
    // Sometimes a newer connection supersedes the pending one before promotion.
    if (epoch % 3 === 0) {
      assert.ok(server.controlLaneState().lanes <= 3);
      continue;
    }
    promote([client, server], next);
    assert.ok(server.controlLaneState().lanes <= 3, `epoch ${epoch}`);
    assert.equal(server.controlLaneState().epochFloor, epoch);
    if (previous) {
      assert.throws(() => server.registerControlLane(previous), /retired/);
      await assert.rejects(() => client.sealControl({}, previous), /retired/);
    }
    previous = next;
  }
  assert.deepEqual(server.controlLaneState(), { lanes: 2, epochFloor: 1_000 });
  // A superseded pending lane (epoch 999 was pending when 1 000 arrived) is retired too.
  assert.equal((await server.openControl(await client.sealControl({}, previous), previous)).stale, false);
  assert.throws(() => server.registerControlLane(lane(999)), /retired/);
  assert.throws(() => server.activateControlLane(lane(999)), /not pending/);
});
