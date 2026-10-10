import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from './remote-e2ee.ts';
import {
  MEDIA_SEGMENT_BYTES,
  createMediaFrameReader,
  decryptMediaMeta,
  decryptMediaSegment,
  encryptMediaMeta,
  encryptMediaSegment,
} from './remote-media-crypto.ts';

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const asset = { assetId: 'aaaaaaaa-1111', variant: 'original' };
const bodyOf = (frame) => createMediaFrameReader().push(frame)[0];
const segment = Buffer.alloc(MEDIA_SEGMENT_BYTES, 9);

test('segments and meta round-trip, and every frame has its own nonce', async () => {
  const key = await newKey();
  const meta = { size: 1_000_000, mime: 'video/mp4', start: 65_536, end: 131_071 };
  assert.deepEqual({ ...(await decryptMediaMeta(key, asset, 65_536, bodyOf(await encryptMediaMeta(key, asset, meta)))) }, meta);
  const first = bodyOf(await encryptMediaSegment(key, asset, 0, 1_000_000, segment));
  const second = bodyOf(await encryptMediaSegment(key, asset, 0, 1_000_000, segment));
  assert.deepEqual(Buffer.from(await decryptMediaSegment(key, asset, 0, 1_000_000, first)), segment);
  assert.notDeepEqual(first.subarray(0, 12), second.subarray(0, 12));
  assert.notDeepEqual(first, second);
});

test('tampered, truncated, swapped and replayed frames are rejected', async () => {
  const key = await newKey();
  const body = bodyOf(await encryptMediaSegment(key, asset, 65_536, 500_000, segment));
  const open = (candidate, target = asset, offset = 65_536, size = 500_000, useKey = key) =>
    decryptMediaSegment(useKey, target, offset, size, candidate);
  await open(body);
  const flipped = Uint8Array.from(body);
  flipped[40] ^= 1;
  await assert.rejects(open(flipped));
  const flippedNonce = Uint8Array.from(body);
  flippedNonce[0] ^= 1;
  await assert.rejects(open(flippedNonce));
  await assert.rejects(open(body.subarray(0, body.length - 1)));
  await assert.rejects(open(body.subarray(0, 20)), /Truncated/);
  // Moved to another asset, variant, offset or file size.
  await assert.rejects(open(body, { ...asset, assetId: 'bbbbbbbb-2222' }));
  await assert.rejects(open(body, { ...asset, variant: 'thumb' }));
  await assert.rejects(open(body, asset, 0));
  await assert.rejects(open(body, asset, 65_536, 500_001));
  // Another session's key.
  await assert.rejects(open(body, asset, 65_536, 500_000, await newKey()));
  // A data frame is not a meta frame and vice versa.
  await assert.rejects(decryptMediaMeta(key, asset, 65_536, body));
  const metaBody = bodyOf(await encryptMediaMeta(key, asset, { size: 9, mime: 'a/b', start: 0, end: 8 }));
  await assert.rejects(decryptMediaSegment(key, asset, 0, 9, metaBody));
  // A meta answering a different requested window.
  await assert.rejects(decryptMediaMeta(key, asset, 65_536, metaBody));
});

test('the frame reader reassembles any chunking and refuses absurd lengths', async () => {
  const key = await newKey();
  const frames = [
    await encryptMediaSegment(key, asset, 0, 3 * MEDIA_SEGMENT_BYTES, segment),
    await encryptMediaSegment(key, asset, MEDIA_SEGMENT_BYTES, 3 * MEDIA_SEGMENT_BYTES, segment),
  ];
  const wire = Buffer.concat(frames);
  const reader = createMediaFrameReader();
  const bodies = [];
  for (let at = 0; at < wire.length; at += 1000) bodies.push(...reader.push(wire.subarray(at, at + 1000)));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodyOf(frames[1]));
  assert.throws(() => createMediaFrameReader().push(Buffer.from([0xff, 0xff, 0xff, 0xff])), /length/);
});

test('both ends of a handshake derive the same media key, only when the host advertises it', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const pairing = relayE2EEPairingMaterial(identity);
  const connect = async (extra) => {
    const challenge = { ...createRelayE2EEChallenge(), ...extra };
    const client = await createRelayE2EEClientHandshake(pairing, challenge);
    const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
    return { client: client.channel, server };
  };
  const { client, server } = await connect({ mediaE2ee: 1 });
  const frame = await encryptMediaSegment(server.mediaKey, asset, 0, 10, Buffer.from('0123456789'));
  assert.equal(Buffer.from(await decryptMediaSegment(client.mediaKey, asset, 0, 10, bodyOf(frame))).toString(), '0123456789');
  // A different session cannot open it.
  const other = await connect({ mediaE2ee: 1 });
  await assert.rejects(decryptMediaSegment(other.client.mediaKey, asset, 0, 10, bodyOf(frame)));
  // An older host never advertises the lane, so no key exists on either side.
  const legacy = await connect({});
  assert.equal(legacy.client.mediaKey, null);
  assert.equal(legacy.server.mediaKey, null);
});
