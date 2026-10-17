import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MEDIA_SEGMENT_BYTES,
  createMediaFrameReader,
  decryptMediaMeta,
  decryptMediaSegment,
} from '../shared/remote-media-crypto.ts';
import { FileDownloadError } from '../shared/file-downloads.ts';
import { createFileDownloadService } from './file-downloads.ts';
import { leaseMediaFile } from './media-leases.ts';
import { DOWNLOAD_WINDOW_MAX_BYTES, MEDIA_WINDOW_MAX_BYTES, createRelayMediaLane } from './remote-relay-media.ts';

const SID = 'S'.repeat(43);
const SID_OTHER = 'O'.repeat(43);
const PHONE = { deviceId: 'phone-credential' };
const OTHER = { deviceId: 'tablet-credential' };
const ENC = 'e2ee1';
const dir = mkdtempSync(join(tmpdir(), 'relay-media-'));
const file = (name, size) => {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return {
    bytes,
    assetId: leaseMediaFile(path, 'video/mp4', { within: dir, identity: statSync(path, { bigint: true }) }),
  };
};

async function makeLane(options = {}) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const sent = [];
  const devices = options.devices ?? { [SID]: PHONE.deviceId, [SID_OTHER]: OTHER.deviceId };
  const lane = createRelayMediaLane({
    host: options.host ?? { invokeCapability: async () => null },
    sendEnvelope: (envelope) => sent.push(envelope),
    socketBacklog: () => (typeof options.backlog === 'function' ? options.backlog() : (options.backlog ?? 0)),
    mediaKey: (sid) => (sid in devices ? key : null),
    mediaDevice: (sid) => devices[sid] ?? null,
    downloads: options.downloads,
  });
  return { key, lane, sent };
}

async function decodeWindow(key, request, sent) {
  const asset = { assetId: request.assetId, variant: request.variant };
  const reader = createMediaFrameReader();
  const bodies = sent
    .filter((envelope) => envelope.type === 'media-chunk')
    .flatMap((envelope) => reader.push(Buffer.from(envelope.data, 'base64')));
  const alignedStart =
    Math.floor(Number(/bytes=(\d+)/.exec(request.range)?.[1] ?? 0) / MEDIA_SEGMENT_BYTES) * MEDIA_SEGMENT_BYTES;
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
  const request = {
    id: 'r1',
    assetId,
    variant: 'original',
    method: 'GET',
    range: 'bytes=70000-70009',
    sid: SID,
    enc: ENC,
  };
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
  const tailRequest = {
    id: 't',
    assetId: tail.assetId,
    variant: 'original',
    method: 'GET',
    range: 'bytes=65536-',
    sid: SID,
    enc: ENC,
  };
  await lane.serve(tailRequest);
  const tailWindow = await decodeWindow(key, tailRequest, sent);
  assert.equal(tailWindow.meta.end, 99_999);
  assert.deepEqual(tailWindow.plaintext, tail.bytes.subarray(65_536));
  sent.length = 0;
  const bigRequest = {
    id: 'b',
    assetId: big.assetId,
    variant: 'original',
    method: 'GET',
    range: '',
    sid: SID,
    enc: ENC,
  };
  await lane.serve(bigRequest);
  const bigWindow = await decodeWindow(key, bigRequest, sent);
  assert.equal(bigWindow.meta.start, 0);
  assert.equal(bigWindow.meta.end, MEDIA_WINDOW_MAX_BYTES - 1);
  assert.deepEqual(bigWindow.plaintext, big.bytes.subarray(0, MEDIA_WINDOW_MAX_BYTES));
});

test('a leased project file is re-authorized by where the opened file really is', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'relay-media-lease-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(project, 'media'), { recursive: true });
  mkdirSync(join(project, '.ssh'));
  mkdirSync(elsewhere);
  writeFileSync(join(project, 'media', 'clip.mp4'), 'project clip');
  writeFileSync(join(project, '.ssh', 'clip.mp4'), 'private key');
  writeFileSync(join(elsewhere, 'clip.mp4'), 'outside bytes');
  const path = join(project, 'media', 'clip.mp4');
  const lease = () =>
    leaseMediaFile(path, 'video/mp4', { within: project, identity: statSync(path, { bigint: true }) });
  const serve = async (assetId) => {
    const { lane, sent } = await makeLane();
    await lane.serve({ id: 'l', assetId, variant: 'original', method: 'GET', range: '', sid: SID, enc: ENC });
    return sent[0].status;
  };
  assert.equal(await serve(lease()), 200);
  // Before the fix the lane opened the leased path as it stood at serve
  // time: a folder swapped for a link out of the project, or onto a secret
  // folder, served whatever the link led to.
  for (const target of [elsewhere, join(project, '.ssh')]) {
    const assetId = lease();
    rmSync(join(project, 'media'), { recursive: true, force: true });
    symlinkSync(target, join(project, 'media'), 'junction');
    assert.equal(await serve(assetId), 404, target);
    rmSync(join(project, 'media'), { recursive: true, force: true });
    mkdirSync(join(project, 'media'));
    writeFileSync(path, 'project clip');
  }
  // Another file now at the leased path is not the authorized one.
  // The leased file is moved aside, not deleted: POSIX filesystems hand a
  // freed inode number straight to the next file created, so a delete and
  // rewrite can land on the very (dev, ino) the lease holds, and then it is
  // the same file by identity. Windows file ids are not reused that way.
  const assetId = lease();
  renameSync(path, join(project, 'media', 'clip.moved.mp4'));
  writeFileSync(path, 'replaced');
  assert.equal(await serve(assetId), 404);
});

test('a gallery asset resolving to a secret file, by name or through a link, is never served', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'relay-media-gallery-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'gallery'));
  mkdirSync(join(base, '.ssh'));
  writeFileSync(join(base, 'gallery', 'shot.png'), 'gallery bytes');
  writeFileSync(join(base, '.ssh', 'id_rsa'), 'private key');
  writeFileSync(join(base, '.env'), 'TOKEN=1');
  symlinkSync(join(base, '.ssh'), join(base, 'linked'), 'junction');
  const serve = async (assetId, path) => {
    const host = {
      invokeCapability: async (name, [id]) =>
        name === 'resolveMediaFile' && id === assetId ? { value: { path, mime: 'image/png' } } : null,
    };
    const { lane, sent } = await makeLane({ host });
    await lane.serve({ id: 'g', assetId, variant: 'original', method: 'GET', range: '', sid: SID, enc: ENC });
    return sent[0].status;
  };
  assert.equal(await serve('a0000000-0000-0000-0000-000000000001', join(base, 'gallery', 'shot.png')), 200);
  assert.equal(await serve('a0000000-0000-0000-0000-000000000002', join(base, '.env')), 404);
  assert.equal(await serve('a0000000-0000-0000-0000-000000000003', join(base, '.ssh', 'id_rsa')), 404);
  assert.equal(await serve('a0000000-0000-0000-0000-000000000004', join(base, 'linked', 'id_rsa')), 404);
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
    assert.equal(
      sent.some((envelope) => envelope.type === 'media-chunk'),
      false
    );
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
    await lane.serve({
      id: 'old',
      assetId,
      variant: 'thumb',
      method: 'GET',
      range: 'bytes=0-9',
      sid: '',
      enc: '',
      ...extra,
    });
    assert.equal(sent[0].type, 'media-head');
    assert.ok([403, 404].includes(sent[0].status));
    if (!extra.enc || extra.enc !== ENC) assert.equal(sent[0].status, 404);
    assert.equal(
      sent.some((envelope) => envelope.type === 'media-chunk'),
      false
    );
  }
});

test('a backlogged socket holds the stream back and an abort ends it quietly', async () => {
  const { assetId } = file('slow.mp4', 300_000);
  const { lane, sent } = await makeLane({ backlog: 1e9 });
  const serving = lane.serve({
    id: 'slow',
    assetId,
    variant: 'original',
    method: 'GET',
    range: '',
    sid: SID,
    enc: ENC,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.filter((envelope) => envelope.type === 'media-chunk').length, 1);
  lane.abort('slow');
  await serving;
  assert.equal(
    sent.some((envelope) => envelope.type === 'media-end' || envelope.type === 'media-error'),
    false
  );
});

// ── Download leases (variant `download`, file-downloads.ts) ────────────────

/** The real authorization service over one project with `name` of `size`. */
async function downloadFixture(t, name, size) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'relay-download-')));
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + (index >> 12)) & 0xff;
  writeFileSync(join(project, name), bytes);
  const service = createFileDownloadService({
    mediaLane: true,
    host: {
      listSessions: async () => [{ id: 's1', cwd: project, projectPath: project, classification: 'project' }],
      projectDirectory: async (path) => path,
      invokeCapability: async () => null,
      readSessionTranscript: async () => null,
    },
  });
  t.after(() => service.revokeAll());
  const begin = async (requester = PHONE) => {
    const grant = await service.authorize(requester, {
      source: { kind: 'project', sessionId: 's1', relPath: name },
      purpose: 'save',
    });
    return service.begin(requester, grant.grantId);
  };
  return { service, bytes, path: join(project, name), begin };
}

const downloadRequest = (transfer, extra = {}) => ({
  id: 'd',
  assetId: transfer.media.assetId,
  variant: 'download',
  method: 'GET',
  range: '',
  sid: SID,
  enc: ENC,
  ...extra,
});

test('a download lease streams its own file, version-bound, in larger windows of authenticated segments', async (t) => {
  const f = await downloadFixture(t, 'out.bin', DOWNLOAD_WINDOW_MAX_BYTES + 70_000);
  const transfer = await f.begin();
  const { key, lane, sent } = await makeLane({ downloads: f.service });
  const request = downloadRequest(transfer);
  await lane.serve(request);
  assert.equal(sent[0].status, 200);
  assert.equal(sent.at(-1).type, 'media-end');
  const { meta, plaintext } = await decodeWindow(key, request, sent);
  assert.deepEqual(
    { ...meta },
    {
      size: f.bytes.length,
      mime: 'application/octet-stream',
      start: 0,
      end: DOWNLOAD_WINDOW_MAX_BYTES - 1,
      version: transfer.version,
    }
  );
  assert.deepEqual(plaintext, f.bytes.subarray(0, DOWNLOAD_WINDOW_MAX_BYTES));

  // Resume from an acknowledged offset: the next window starts on its segment.
  sent.length = 0;
  const resume = downloadRequest(transfer, { id: 'd2', range: `bytes=${DOWNLOAD_WINDOW_MAX_BYTES + 100}-` });
  await lane.serve(resume);
  const tail = await decodeWindow(key, resume, sent);
  assert.equal(tail.meta.start, DOWNLOAD_WINDOW_MAX_BYTES);
  assert.equal(tail.meta.version, transfer.version);
  assert.deepEqual(tail.plaintext, f.bytes.subarray(DOWNLOAD_WINDOW_MAX_BYTES));
});

test('a lease is served to its own device only, and never through the gallery resolution', async (t) => {
  const f = await downloadFixture(t, 'mine.bin', 1000);
  const transfer = await f.begin();
  let galleryAsked = false;
  const { lane, sent } = await makeLane({
    downloads: f.service,
    host: {
      invokeCapability: async () => {
        galleryAsked = true;
        return null;
      },
    },
  });
  for (const extra of [
    { sid: SID_OTHER },
    { assetId: '00000000-0000-4000-8000-000000000000' },
    { variant: 'original' },
  ]) {
    sent.length = 0;
    await lane.serve(downloadRequest(transfer, extra));
    assert.equal(sent[0].status, 404, JSON.stringify(extra));
    assert.equal(
      sent.some((envelope) => envelope.type === 'media-chunk'),
      false
    );
  }
  assert.equal(galleryAsked, true, 'only the original variant asked the gallery');
  galleryAsked = false;
  sent.length = 0;
  await lane.serve(downloadRequest(transfer, { assetId: '00000000-0000-4000-8000-000000000000' }));
  assert.equal(galleryAsked, false);
  // Without a lane for downloads at all, nothing is served either.
  const bare = await makeLane();
  await bare.lane.serve(downloadRequest(transfer));
  assert.equal(bare.sent[0].status, 404);
});

test('a file that changed is refused as 412 before any byte, and the lease then ends', async (t) => {
  const f = await downloadFixture(t, 'moving.bin', 200_000);
  const transfer = await f.begin();
  const { lane, sent } = await makeLane({ downloads: f.service });
  appendFileSync(f.path, '+');
  await lane.serve(downloadRequest(transfer, { range: 'bytes=65536-' }));
  assert.equal(sent[0].status, 412);
  assert.equal(
    sent.some((envelope) => envelope.type === 'media-chunk'),
    false
  );
  sent.length = 0;
  await lane.serve(downloadRequest(transfer));
  assert.equal(sent[0].status, 404);
});

test('a file that changes mid-stream breaks the body off with an error', async () => {
  const bytes = Buffer.alloc(300_000, 3);
  let reads = 0;
  const downloads = {
    resolveMedia: () => ({
      size: bytes.length,
      mime: 'application/zip',
      version: 'V'.repeat(43),
      read: async (offset, length) => {
        reads += 1;
        if (reads > 2) throw new FileDownloadError('changed', 'The file changed on the host.');
        return bytes.subarray(offset, offset + length);
      },
    }),
  };
  const { lane, sent } = await makeLane({ downloads });
  await lane.serve({ ...downloadRequest({ media: { assetId: '00000000-0000-4000-8000-000000000001' } }) });
  assert.equal(sent[0].status, 200);
  assert.equal(sent.at(-1).type, 'media-error');
  // Meta plus the two segments read before the change.
  assert.equal(sent.filter((envelope) => envelope.type === 'media-chunk').length, 3);
});

test('an aborted download stops reading and leaves no read holding the lease handle', async () => {
  const bytes = Buffer.alloc(DOWNLOAD_WINDOW_MAX_BYTES, 5);
  const reads = [];
  let inflight = 0;
  let backlog = 0;
  const downloads = {
    resolveMedia: () => ({
      size: bytes.length,
      mime: 'application/octet-stream',
      version: 'V'.repeat(43),
      read: async (offset, length) => {
        reads.push([offset, length]);
        inflight += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        inflight -= 1;
        return bytes.subarray(offset, offset + length);
      },
    }),
  };
  const { lane, sent } = await makeLane({ downloads, backlog: () => backlog });
  const request = downloadRequest({ media: { assetId: '00000000-0000-4000-8000-000000000002' } }, { id: 'ab' });
  const serving = lane.serve(request);
  // Let a few segments through, then stall the socket and abort.
  while (sent.filter((envelope) => envelope.type === 'media-chunk').length < 4) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  backlog = 1e9;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const readsAtStall = reads.length;
  lane.abort('ab');
  await serving;
  assert.equal(inflight, 0);
  assert.equal(reads.length, readsAtStall, 'nothing is read after the abort');
  assert.ok(reads.length < bytes.length / MEDIA_SEGMENT_BYTES, 'the stalled pump did not read ahead');
  // Every read is one bounded segment: the pump never buffers a window.
  assert.ok(reads.every(([, length]) => length <= MEDIA_SEGMENT_BYTES));
  assert.equal(
    sent.some((envelope) => envelope.type === 'media-end' || envelope.type === 'media-error'),
    false
  );
});

test('a zero-byte lease answers with its meta and no segments', async (t) => {
  const f = await downloadFixture(t, 'empty.bin', 0);
  const transfer = await f.begin();
  const { key, lane, sent } = await makeLane({ downloads: f.service });
  const request = downloadRequest(transfer);
  await lane.serve(request);
  const { meta, bodies } = await decodeWindow(key, request, sent);
  assert.deepEqual([meta.size, meta.start, meta.end, bodies.length], [0, 0, -1, 1]);
});
