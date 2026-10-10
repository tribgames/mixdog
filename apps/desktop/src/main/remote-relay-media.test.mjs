import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MEDIA_SEGMENT_BYTES,
  createMediaFrameReader,
  decryptMediaMeta,
  decryptMediaSegment,
} from '../shared/remote-media-crypto.ts';
import { leaseMediaFile } from './media-leases.ts';
import { MEDIA_WINDOW_MAX_BYTES, createRelayMediaLane } from './remote-relay-media.ts';

const SID = 'S'.repeat(43);
const ENC = 'e2ee1';
const dir = mkdtempSync(join(tmpdir(), 'relay-media-'));
const file = (name, size) => {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { bytes, assetId: leaseMediaFile(path, 'video/mp4') };
};

async function makeLane(options = {}) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const sent = [];
  const lane = createRelayMediaLane({
    host: { invokeCapability: async () => null },
    sendEnvelope: (envelope) => sent.push(envelope),
    socketBacklog: () => options.backlog ?? 0,
    mediaKey: (sid) => (sid === SID ? key : null),
  });
  return { key, lane, sent };
}

async function decodeWindow(key, request, sent) {
  const asset = { assetId: request.assetId, variant: request.variant };
  const reader = createMediaFrameReader();
  const bodies = sent
    .filter((envelope) => envelope.type === 'media-chunk')
    .flatMap((envelope) => reader.push(Buffer.from(envelope.data, 'base64')));
  const alignedStart = Math.floor(Number(/bytes=(\d+)/.exec(request.range)?.[1] ?? 0) / MEDIA_SEGMENT_BYTES) * MEDIA_SEGMENT_BYTES;
  const meta = await decryptMediaMeta(key, asset, alignedStart, bodies[0]);
  const parts = [];
  let offset = meta.start;
  for (const body of bodies.slice(1)) {
    const part = await decryptMediaSegment(key, asset, offset, meta.size, body);
    parts.push(Buffer.from(part));
    offset += part.byteLength;
  }
  return { meta, plaintext: Buffer.concat(parts), bodies };
}

test('a range is served as encrypted, segment-aligned frames that decrypt to the file bytes', async () => {
  const { bytes, assetId } = file('a.mp4', 200_000);
  const { key, lane, sent } = await makeLane();
  const request = { id: 'r1', assetId, variant: 'original', method: 'GET', range: 'bytes=70000-70009', sid: SID, enc: ENC };
  await lane.serve(request);
  assert.equal(sent[0].type, 'media-head');
  assert.equal(sent[0].status, 200);
  assert.equal(sent.at(-1).type, 'media-end');
  const { meta, plaintext, bodies } = await decodeWindow(key, request, sent);
  assert.deepEqual({ ...meta }, { size: 200_000, mime: 'video/mp4', start: 65_536, end: 131_071 });
  assert.deepEqual(plaintext, bytes.subarray(65_536, 131_072));
  // The relay sees ciphertext only: no frame contains a run of file bytes.
  const wire = Buffer.concat(sent.filter((e) => e.type === 'media-chunk').map((e) => Buffer.from(e.data, 'base64')));
  assert.equal(wire.includes(bytes.subarray(65_536, 65_536 + 64)), false);
  assert.equal(bodies.length, 2);
});

test('the last window stops at EOF and open-ended ranges are capped to one window', async () => {
  const tail = file('tail.mp4', 100_000);
  const big = file('big.mp4', MEDIA_WINDOW_MAX_BYTES * 2 + 5);
  const { key, lane, sent } = await makeLane();
  const tailRequest = { id: 't', assetId: tail.assetId, variant: 'original', method: 'GET', range: 'bytes=65536-', sid: SID, enc: ENC };
  await lane.serve(tailRequest);
  const tailWindow = await decodeWindow(key, tailRequest, sent);
  assert.equal(tailWindow.meta.end, 99_999);
  assert.deepEqual(tailWindow.plaintext, tail.bytes.subarray(65_536));
  sent.length = 0;
  const bigRequest = { id: 'b', assetId: big.assetId, variant: 'original', method: 'GET', range: '', sid: SID, enc: ENC };
  await lane.serve(bigRequest);
  const bigWindow = await decodeWindow(key, bigRequest, sent);
  assert.equal(bigWindow.meta.start, 0);
  assert.equal(bigWindow.meta.end, MEDIA_WINDOW_MAX_BYTES - 1);
  assert.deepEqual(bigWindow.plaintext, big.bytes.subarray(0, MEDIA_WINDOW_MAX_BYTES));
});

test('requests without a known session, or for unknown or unsupported things, are refused', async () => {
  const { assetId } = file('r.mp4', 1000);
  const { lane, sent } = await makeLane();
  const base = { id: 'x', assetId, variant: 'original', method: 'GET', range: '', enc: ENC };
  for (const [request, status] of [
    [{ ...base, sid: '' }, 403],
    [{ ...base, sid: 'T'.repeat(43) }, 403],
    [{ ...base, sid: SID, enc: ENC, method: 'HEAD' }, 405],
    [{ ...base, sid: SID, enc: ENC, assetId: 'deadbeef-0000-0000-0000-000000000000' }, 404],
    [{ ...base, sid: SID, enc: ENC, range: 'bytes=5000-' }, 416],
  ]) {
    sent.length = 0;
    await lane.serve(request);
    assert.equal(sent[0].status, status);
    assert.equal(sent.some((envelope) => envelope.type === 'media-chunk'), false);
  }
});

test('a request that did not opt into the encrypted scheme is answered like no media, never with ciphertext', async () => {
  const { assetId } = file('legacy.mp4', 100_000);
  const { lane, sent } = await makeLane();
  // An older renderer (via an older or newer relay) asks for plaintext: it has
  // no sid and no scheme marker. Even a request with a valid sid but no
  // marker, or an unknown marker, gets nothing.
  for (const extra of [{}, { sid: SID }, { sid: SID, enc: '' }, { sid: SID, enc: 'e2ee0' }, { enc: ENC, sid: '' }]) {
    sent.length = 0;
    await lane.serve({ id: 'old', assetId, variant: 'thumb', method: 'GET', range: 'bytes=0-9', sid: '', enc: '', ...extra });
    assert.equal(sent[0].type, 'media-head');
    assert.ok([403, 404].includes(sent[0].status));
    if (!extra.enc || extra.enc !== ENC) assert.equal(sent[0].status, 404);
    assert.equal(sent.some((envelope) => envelope.type === 'media-chunk'), false);
  }
});

test('a backlogged socket holds the stream back and an abort ends it quietly', async () => {
  const { assetId } = file('slow.mp4', 300_000);
  const { lane, sent } = await makeLane({ backlog: 1e9 });
  const serving = lane.serve({ id: 'slow', assetId, variant: 'original', method: 'GET', range: '', sid: SID, enc: ENC });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.filter((envelope) => envelope.type === 'media-chunk').length, 1);
  lane.abort('slow');
  await serving;
  assert.equal(sent.some((envelope) => envelope.type === 'media-end' || envelope.type === 'media-error'), false);
});
