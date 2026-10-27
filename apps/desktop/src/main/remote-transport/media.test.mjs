// The transport media adapter against the HTTP lane it replaces. The adapter
// runs over a stand-in for the 1A coordinator built from the real contract
// pieces: a real E2EE transport session seals every record, the real
// RemoteTransportSender admits and charges it, and the carrier queue counts
// the real carrier messages (framing included). The phone side opens the
// boxes in order, exactly as its receiver would deliver them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { FileDownloadError } from '../../shared/file-downloads.ts';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from '../../shared/remote-e2ee.ts';
import {
  MEDIA_SEGMENT_BYTES,
  createMediaFrameReader,
  decryptMediaMeta,
  decryptMediaSegment,
} from '../../shared/remote-media-crypto.ts';
import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_BUFFER_LOW_BYTES,
  REMOTE_TRANSPORT_MAX_MEDIA_STREAMS,
  REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES,
  REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES,
  RemoteTransportSender,
  encodeRemoteTransportRecord,
  readRemoteTransportControl,
  readRemoteTransportMedia,
  remoteTransportAck,
  remoteTransportRecordCharge,
} from '../../shared/remote-transport.ts';
import { waitUntil } from '../bounded-wait.mjs';
import { createFileDownloadService } from '../file-downloads.ts';
import { leaseMediaFile } from '../media-leases.ts';
import { DOWNLOAD_WINDOW_MAX_BYTES, MEDIA_WINDOW_MAX_BYTES, createRelayMediaLane } from '../remote-relay-media.ts';
import { createRemoteTransportMediaAdapter } from './media.ts';
import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const SID = 'S'.repeat(43);
const PHONE = 'phone-credential';
const ENC = 'e2ee1';
const NO_HOST = { invokeCapability: async () => null };
// Acks travel the relay carrier's control lane here.
const RELAY_LANE = { kind: 'relay' };
const dir = realpathSync(makeTempDirSync('transport-media'));

function file(name, size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return {
    bytes,
    assetId: leaseMediaFile(path, 'video/mp4', { within: dir, identity: statSync(path, { bigint: true }) }),
  };
}

async function session() {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1, mediaE2ee: 1 };
  const client = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge, {
    transportWebrtc: true,
  });
  const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
  client.channel.confirmHandshake({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() });
  assert.ok(server.transportEnabled && server.mediaKey);
  return { client: client.channel, server };
}

/** The coordinator stand-in: split is not needed (a media record is one
 *  record), admission → seal → push is serialized, and every carrier message
 *  of a record adds its wire bytes to the carrier queue. */
function transport({ client, server }, { drained = false } = {}) {
  const sender = new RemoteTransportSender();
  const carrier = { queued: 0, wire: 0 };
  const boxes = [];
  const listeners = new Set();
  const messages = [];
  let sealing = Promise.resolve();
  let busy = 0;
  let opened = 0;
  const violations = [];
  const seal = (value, admission = {}) => {
    busy += 1;
    const run = sealing.then(async () => {
      if (!sender.canAdmit({ ...admission, bufferedAmount: carrier.queued })) return false;
      const box = await server.encryptBinary(value);
      const sequence = sender.push(box, admission);
      const wire = encodeRemoteTransportRecord(box).reduce((sum, message) => sum + message.byteLength, 0);
      if (!drained) carrier.queued += wire;
      carrier.wire += wire;
      sender.markSent(sequence, 'direct:test', 0);
      boxes.push({ sequence, box, wire, stream: admission.stream ?? null });
      return true;
    });
    sealing = run.then(
      () => (busy -= 1),
      () => (busy -= 1)
    );
    return run;
  };
  const writable = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    pair: { client, server },
    sender,
    carrier,
    boxes,
    listeners,
    idle: () => busy === 0,
    link: {
      canAdmit: (stream) => sender.canAdmit({ stream, bufferedAmount: carrier.queued }),
      send: (message, admission) => seal(message, admission),
      onWritable(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      protocolError: (detail) => violations.push(detail),
    },
    violations,
    rpc: (value) => seal(value, {}),
    writable,
    setQueued(bytes) {
      carrier.queued = bytes;
      writable();
    },
    /** The phone's authenticated cumulative ack of everything sealed so far;
     *  `drain` also empties the carrier queue (the records left it). */
    async ack({ drain = true } = {}) {
      const through = boxes.at(-1)?.sequence ?? 0;
      const box = await client.sealControl(remoteTransportAck(through), RELAY_LANE);
      sender.acknowledge(readRemoteTransportControl(await server.openControl(box, RELAY_LANE), 'client'), 0);
      if (drain) carrier.queued = 0;
      writable();
    },
    /** Every application message sealed so far, opened in order. */
    async read() {
      while (opened < boxes.length) {
        messages.push(await client.decryptJson(boxes[opened].box));
        opened += 1;
      }
      return messages;
    },
  };
}

const request = (id, fields) => ({
  type: 'transport-media',
  op: 'request',
  id,
  variant: 'original',
  range: '',
  enc: ENC,
  ...fields,
});

/** Serves one request over the adapter, acking as the phone drains, until it ends. */
async function serveDirect(t, adapter, message) {
  adapter.receive(message);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const mine = (await t.read()).filter((m) => m.id === message.id);
    if (mine.some((m) => m.op === 'end' || m.op === 'error')) return mine;
    assert.ok(Date.now() < deadline, 'the direct window ends');
    await t.ack();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Status, authenticated meta and plaintext of one window's frames. */
async function decode(key, asset, range, status, frames) {
  if (status !== 200) return { status, frames: frames.length };
  const reader = createMediaFrameReader();
  const bodies = frames.flatMap((frame) => reader.push(frame));
  const alignedStart =
    Math.floor(Number(/bytes=(\d+)/.exec(range)?.[1] ?? 0) / MEDIA_SEGMENT_BYTES) * MEDIA_SEGMENT_BYTES;
  const meta = await decryptMediaMeta(key, asset, alignedStart, bodies[0]);
  const parts = [];
  let offset = meta.start;
  for (const body of bodies.slice(1)) {
    const part = await decryptMediaSegment(key, asset, offset, meta.size, body);
    parts.push(Buffer.from(part));
    offset += part.byteLength;
  }
  const plaintext = Buffer.concat(parts);
  return { status, meta: { ...meta }, sha256: createHash('sha256').update(plaintext).digest('hex'), plaintext };
}

async function overHttp(sources, key, device, fields) {
  const sent = [];
  const lane = createRelayMediaLane({
    ...sources,
    sendEnvelope: (envelope) => sent.push(envelope),
    socketBacklog: () => 0,
    mediaKey: (sid) => (sid === SID ? key : null),
    mediaDevice: (sid) => (sid === SID ? device : null),
  });
  const media = { id: 'h', method: 'GET', sid: SID, enc: ENC, variant: 'original', range: '', ...fields };
  await lane.serve(media);
  const frames = sent.filter((e) => e.type === 'media-chunk').map((e) => Buffer.from(e.data, 'base64'));
  return decode(key, { assetId: media.assetId, variant: media.variant }, media.range, sent[0].status, frames);
}

/** One request over a fresh adapter of the session `t` carries. */
async function overTransport(sources, t, device, fields, id) {
  const { pair } = t;
  const adapter = createRemoteTransportMediaAdapter({
    ...sources,
    link: t.link,
    mediaKey: pair.server.mediaKey,
    device,
  });
  const message = request(id, fields);
  const mine = await serveDirect(t, adapter, message);
  // Every message the phone receives is a valid desktop → client media message.
  for (const m of mine) assert.deepEqual(readRemoteTransportMedia(m, 'desktop'), m);
  const frames = mine.filter((m) => m.op === 'chunk').map((m) => Buffer.from(m.frame, 'base64url'));
  const head = mine.find((m) => m.op === 'head');
  return decode(
    pair.client.mediaKey,
    { assetId: message.assetId, variant: message.variant },
    message.range,
    head?.status,
    frames
  );
}

async function downloadFixture(t, name, size) {
  const project = realpathSync(makeTempDirSync('transport-download'));
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
  const begin = async (deviceId = PHONE) => {
    const requester = { deviceId };
    const grant = await service.authorize(requester, {
      source: { kind: 'project', sessionId: 's1', relPath: name },
      purpose: 'save',
    });
    return service.begin(requester, grant.grantId);
  };
  return { service, bytes, path: join(project, name), begin };
}

test('both lanes answer every range with the same status, the same version and byte-identical plaintext', async (t) => {
  const pair = await session();
  const stream = transport(pair);
  const size = MEDIA_WINDOW_MAX_BYTES * 2 + 123;
  const clip = file('parity.mp4', size);
  const f = await downloadFixture(t, 'parity.bin', DOWNLOAD_WINDOW_MAX_BYTES + 70_000);
  const transfer = await f.begin();
  const sources = { host: NO_HOST, downloads: f.service };
  const cases = [
    [clip, { assetId: clip.assetId }],
    [clip, { assetId: clip.assetId, range: 'bytes=1500000-1500099' }],
    [clip, { assetId: clip.assetId, range: `bytes=${size - 70_000}-` }],
    [clip, { assetId: clip.assetId, range: 'bytes=0-0' }],
    [clip, { assetId: clip.assetId, range: `bytes=${size + 10}-` }],
    [clip, { assetId: clip.assetId, variant: 'bogus' }],
    [f, { assetId: transfer.media.assetId, variant: 'download' }],
    [f, { assetId: transfer.media.assetId, variant: 'download', range: `bytes=${DOWNLOAD_WINDOW_MAX_BYTES + 100}-` }],
  ];
  let index = 0;
  for (const [source, fields] of cases) {
    index += 1;
    // The HTTP lane never sees a bogus variant: the relay's route refuses it.
    const http =
      fields.variant === 'bogus'
        ? { status: 404, frames: 0 }
        : await overHttp(sources, pair.server.mediaKey, PHONE, fields);
    const direct = await overTransport(sources, stream, PHONE, fields, `p${index}`);
    const label = JSON.stringify(fields);
    assert.deepEqual({ ...direct, plaintext: undefined }, { ...http, plaintext: undefined }, label);
    if (http.status === 200) {
      assert.deepEqual(direct.plaintext, source.bytes.subarray(http.meta.start, http.meta.end + 1), label);
      if (fields.variant === 'download') assert.equal(direct.meta.version, transfer.version, label);
    }
  }
  // The windows really differ: seeking moved the aligned start and the window.
  assert.equal((await overHttp(sources, pair.server.mediaKey, PHONE, cases[1][1])).meta.start, 1_441_792);
});

test('the lease is authorized by this session only: its device, its media key, the scheme opt-in', async (t) => {
  const pair = await session();
  const f = await downloadFixture(t, 'mine.bin', 1000);
  const transfer = await f.begin();
  const sources = { host: NO_HOST, downloads: f.service };
  const fields = { assetId: transfer.media.assetId, variant: 'download' };
  // Another device's session, on either lane, finds no such download.
  assert.equal((await overHttp(sources, pair.server.mediaKey, 'tablet-credential', fields)).status, 404);
  const stream = transport(pair);
  assert.equal((await overTransport(sources, stream, 'tablet-credential', fields, 'd1')).status, 404);
  // No media key on the session: 403, as an unknown sid is on the HTTP lane.
  const keyless = createRemoteTransportMediaAdapter({ ...sources, link: stream.link, mediaKey: null, device: PHONE });
  const refused = await serveDirect(stream, keyless, request('d2', fields));
  assert.deepEqual(
    refused.map((m) => [m.op, m.status]),
    [
      ['head', 403],
      ['end', undefined],
    ]
  );
  // A request without the encrypted scheme is answered like no media.
  assert.equal((await overTransport(sources, stream, PHONE, { ...fields, enc: 'e2ee0' }, 'd3')).status, 404);
  // And its own device is served.
  assert.equal((await overTransport(sources, stream, PHONE, fields, 'd4')).status, 200);
});

test('a changed file is refused as 412 before any byte on both lanes; a change mid-stream breaks the body off', async (t) => {
  const pair = await session();
  const f = await downloadFixture(t, 'moving.bin', 200_000);
  const transfer = await f.begin();
  const sources = { host: NO_HOST, downloads: f.service };
  appendFileSync(f.path, '+');
  const fields = { assetId: transfer.media.assetId, variant: 'download', range: 'bytes=65536-' };
  const stream = transport(pair);
  assert.deepEqual(await overTransport(sources, stream, PHONE, fields, 'c1'), { status: 412, frames: 0 });
  // The lease ended with the refusal, on both lanes alike.
  assert.equal((await overTransport(sources, stream, PHONE, fields, 'c2')).status, 404);
  assert.equal((await overHttp(sources, pair.server.mediaKey, PHONE, fields)).status, 404);

  const bytes = Buffer.alloc(300_000, 3);
  let reads = 0;
  const changing = {
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
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: changing,
    link: stream.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  const mine = await serveDirect(
    stream,
    adapter,
    request('c3', { assetId: '00000000-0000-4000-8000-000000000001', variant: 'download' })
  );
  assert.deepEqual(
    mine.map((m) => m.op),
    ['head', 'chunk', 'chunk', 'chunk', 'error']
  );
});

/** A download source of `size` bytes that records every read. */
function recordingDownload(size) {
  const bytes = Buffer.alloc(size, 5);
  const state = { reads: [], inflight: 0 };
  return {
    state,
    downloads: {
      resolveMedia: () => ({
        size,
        mime: 'application/octet-stream',
        version: 'V'.repeat(43),
        read: async (offset, length) => {
          state.reads.push([offset, length]);
          state.inflight += 1;
          await new Promise((resolve) => setImmediate(resolve));
          state.inflight -= 1;
          return bytes.subarray(offset, offset + length);
        },
      }),
    },
  };
}

const LEASE = { assetId: '00000000-0000-4000-8000-000000000002', variant: 'download' };

/** Waits until the pump stopped: nothing being sealed or read, for a while. */
async function settled(t, source) {
  let last = -1;
  for (;;) {
    await waitUntil(() => t.idle() && source.state.inflight === 0, 'the pump to pause');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const now = t.boxes.length * 1e6 + source.state.reads.length;
    if (now === last && t.idle()) return;
    last = now;
  }
}

test('backpressure is the sealed wire bytes: the reader stops at the stream credit, not at a plaintext megabyte', async () => {
  const pair = await session();
  // The carrier drains at once here, so only the stream credit holds the pump.
  const t = transport(pair, { drained: true });
  const source = recordingDownload(4 * 1024 * 1024);
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: source.downloads,
    link: t.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  adapter.receive(request('w1', LEASE));
  await settled(t, source);
  const media = t.boxes.filter((box) => box.stream === 'w1');
  const charged = media.reduce((sum, box) => sum + remoteTransportRecordCharge(box.box.byteLength), 0);
  assert.equal(t.sender.canAdmit({ stream: 'w1' }), false);
  assert.ok(charged <= REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES);
  assert.ok(charged + REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES > REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES);
  // Every segment read was sealed (head and meta are the other two records):
  // the reader waits for credit BEFORE it reads, holding nothing ahead.
  assert.equal(source.state.reads.length, media.length - 2);
  // A sealed segment record (base64url of the encrypted frame, its envelope,
  // box header and tag) is larger than the segment, so the credit admits
  // fewer than a plaintext count would (16 segments to the megabyte).
  const segmentBox = media.at(-1).box.byteLength;
  assert.ok(segmentBox > MEDIA_SEGMENT_BYTES * 1.3, `${segmentBox}`);
  assert.ok(source.state.reads.length * MEDIA_SEGMENT_BYTES < REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES);
  // The carrier counted every carrier message, framing included.
  assert.ok(t.carrier.wire > t.boxes.reduce((sum, box) => sum + box.box.byteLength, 0));
  // The phone's ack returns the credit and the reader continues.
  const before = source.state.reads.length;
  await t.ack();
  await settled(t, source);
  assert.ok(source.state.reads.length > before);
  adapter.close();
});

test('above the low-water mark nothing is sealed and no further segment is read, whatever the high-water mark', async () => {
  const pair = await session();
  const t = transport(pair);
  const source = recordingDownload(2 * 1024 * 1024);
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: source.downloads,
    link: t.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  t.setQueued(REMOTE_TRANSPORT_BUFFER_HIGH_BYTES + 1);
  adapter.receive(request('q1', LEASE));
  await settled(t, source);
  // Only the first segment, read before the head (a 412/404 must be a
  // status, not a broken body), is held; nothing is sealed.
  assert.equal(source.state.reads.length, 1);
  assert.equal(t.boxes.length, 0);
  // Below the high-water mark but above the low-water mark: still paused.
  t.setQueued(REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 1);
  await settled(t, source);
  assert.deepEqual([source.state.reads.length, t.boxes.length], [1, 0]);
  // At the low-water mark the stream moves again, and stops once its own
  // records fill the carrier past it.
  t.setQueued(REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
  await settled(t, source);
  assert.ok(t.boxes.length >= 1);
  assert.ok(t.carrier.queued > REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
  adapter.close();
});

test('an RPC sent during a download is admitted at once and queues behind at most the low-water mark of media', async () => {
  const pair = await session();
  const t = transport(pair);
  const source = recordingDownload(DOWNLOAD_WINDOW_MAX_BYTES);
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: source.downloads,
    link: t.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  adapter.receive(request('r1', LEASE));
  // The phone acks everything at once but the carrier never drains: the
  // download runs into the low-water mark of its carrier queue.
  for (let round = 0; round < 40 && t.carrier.queued <= REMOTE_TRANSPORT_BUFFER_LOW_BYTES; round += 1) {
    await settled(t, source);
    await t.ack({ drain: false });
  }
  await settled(t, source);
  assert.ok(t.carrier.queued > REMOTE_TRANSPORT_BUFFER_LOW_BYTES, 'the download filled the carrier');
  assert.equal(t.link.canAdmit('r1'), false, 'media waits');
  const ahead = t.carrier.queued;
  const largestMedia = Math.max(...t.boxes.map((box) => box.wire));
  assert.ok(ahead <= REMOTE_TRANSPORT_BUFFER_LOW_BYTES + largestMedia, `${ahead}`);
  // The RPC is admitted and sealed now, not after the download.
  assert.equal(t.sender.canAdmit({ bufferedAmount: ahead }), true);
  assert.equal(await t.rpc({ type: 'rpc', id: 1, method: 'listSessions' }), true);
  const reads = source.state.reads.length;
  await settled(t, source);
  assert.equal(source.state.reads.length, reads, 'the RPC opened no room for media');
  assert.equal(t.boxes.at(-1).stream, null);
  adapter.close();
});

test('cancel stops the pump: no further read, record, end or error', async () => {
  const pair = await session();
  const t = transport(pair);
  const source = recordingDownload(DOWNLOAD_WINDOW_MAX_BYTES);
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: source.downloads,
    link: t.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  adapter.receive(request('x1', LEASE));
  await settled(t, source);
  await t.ack();
  await settled(t, source);
  const records = t.boxes.length;
  const reads = source.state.reads.length;
  assert.ok(reads >= 2);
  adapter.receive({ type: 'transport-media', op: 'cancel', id: 'x1' });
  await t.ack();
  await settled(t, source);
  assert.equal(source.state.inflight, 0);
  assert.equal(source.state.reads.length, reads, 'nothing is read after the cancel');
  assert.equal(t.boxes.length, records, 'nothing is sealed after the cancel');
  const ops = (await t.read()).map((m) => m.op);
  assert.equal(ops.includes('end') || ops.includes('error'), false);
  assert.ok(source.state.reads.every(([, length]) => length <= MEDIA_SEGMENT_BYTES));
  adapter.close();
});

test('at most 32 streams run; a further one is refused before any head; close stops everything', async () => {
  const pair = await session();
  const t = transport(pair, { drained: true });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const downloads = {
    resolveMedia: () => ({
      size: 1_000_000,
      mime: 'application/octet-stream',
      version: 'V'.repeat(43),
      read: async (_offset, length) => {
        reads += 1;
        await gate;
        return Buffer.alloc(length);
      },
    }),
  };
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads,
    link: t.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  for (let index = 0; index < REMOTE_TRANSPORT_MAX_MEDIA_STREAMS; index += 1)
    adapter.receive(request(`s${index}`, LEASE));
  await waitUntil(() => reads === REMOTE_TRANSPORT_MAX_MEDIA_STREAMS, 'every stream to start reading');
  assert.equal(adapter.receive(request('extra', LEASE)), true);
  await waitUntil(() => t.boxes.length === 1 && t.idle(), 'the refusal');
  assert.deepEqual(await t.read(), [{ type: 'transport-media', op: 'error', id: 'extra' }]);
  assert.equal(t.boxes[0].stream, null, 'a refusal is an ordinary record, not bulk');
  // Not a media message: left to the caller.
  assert.equal(adapter.receive({ type: 'rpc', id: 1 }), false);
  adapter.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitUntil(() => t.idle(), 'sealing to finish');
  assert.equal(t.boxes.length, 1, 'a closed session sends nothing more');
  assert.equal(t.listeners.size, 0);
  adapter.receive(request('late', LEASE));
  assert.equal(reads, REMOTE_TRANSPORT_MAX_MEDIA_STREAMS);
});

/** A coordinator stand-in whose every send stays pending until the test
 *  answers it, and whose admission and notifications the test drives. */
function scriptedLink() {
  const state = { bulk: true, sends: [], listeners: new Set(), violations: [] };
  state.link = {
    canAdmit: () => state.bulk,
    send: (message, admission) =>
      new Promise((resolve) => state.sends.push({ message, stream: admission?.stream ?? null, resolve })),
    onWritable(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    protocolError: (detail) => state.violations.push(detail),
  };
  state.notify = () => {
    for (const listener of [...state.listeners]) listener();
  };
  return state;
}

test('a writable notification that arrives while a refused send is pending still resumes the stream', async () => {
  const pair = await session();
  const s = scriptedLink();
  const source = recordingDownload(1_000_000);
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: source.downloads,
    link: s.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  adapter.receive(request('lw', LEASE));
  await waitUntil(() => s.sends.length === 1, 'the head send');
  // The seal-time check refuses it (another record took the room); while
  // that send was pending, the room came back and the coordinator said so.
  s.notify();
  s.sends[0].resolve(false);
  await waitUntil(() => s.sends.length === 2, 'the retry after the notification it got during its send');
  assert.deepEqual([s.sends[1].message.op, s.sends[1].stream], ['head', 'lw']);
  // A refusal with no notification since the send waits for the next one,
  // instead of spinning.
  s.sends[1].resolve(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.sends.length, 2);
  s.notify();
  await waitUntil(() => s.sends.length === 3, 'the retry after the next notification');
  s.sends[2].resolve(true);
  await waitUntil(() => s.sends.length === 4, 'the meta frame');
  assert.equal(s.sends[3].message.op, 'chunk');
  // A cancel still wakes a stream waiting for a notification.
  s.bulk = false;
  s.sends[3].resolve(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const sends = s.sends.length;
  adapter.receive({ type: 'transport-media', op: 'cancel', id: 'lw' });
  await waitUntil(() => source.state.inflight === 0, 'the pump to stop');
  s.bulk = true;
  s.notify();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.sends.length, sends, 'the cancelled stream sends nothing more');
  adapter.close();
});

test('excess requests on a blocked carrier hold only a bounded refusal queue; overflowing it ends the session', async () => {
  const pair = await session();
  const s = scriptedLink();
  // Bulk is blocked: every pump waits for room before its head.
  s.bulk = false;
  const source = recordingDownload(1_000_000);
  const adapter = createRemoteTransportMediaAdapter({
    host: NO_HOST,
    downloads: source.downloads,
    link: s.link,
    mediaKey: pair.server.mediaKey,
    device: PHONE,
  });
  const max = REMOTE_TRANSPORT_MAX_MEDIA_STREAMS;
  for (let index = 0; index < max; index += 1) adapter.receive(request(`run${index}`, LEASE));
  await waitUntil(
    () => source.state.reads.length === max && source.state.inflight === 0,
    'every pump to wait for room'
  );
  assert.equal(s.sends.length, 0);
  // Excess requests: each is refused by one ordinary (non-bulk) record, sent
  // without waiting for bulk room, one at a time; the carrier holds them.
  for (let index = 0; index < max; index += 1) adapter.receive(request(`over${index}`, LEASE));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.sends.length, 1, 'one refusal in flight, the rest queued by id');
  assert.deepEqual(
    [s.sends[0].message, s.sends[0].stream],
    [{ type: 'transport-media', op: 'error', id: 'over0' }, null]
  );
  assert.equal(source.state.reads.length, max, 'no refused request reads or resolves anything');
  // The carrier refuses it too: the queue waits for a notification, no spin.
  s.sends[0].resolve(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.sends.length, 1);
  // A cancel takes a queued refusal back, so a conforming phone, whose
  // client never has more than the limit outstanding, cannot overflow it.
  adapter.receive({ type: 'transport-media', op: 'cancel', id: 'over5' });
  adapter.receive(request('again', LEASE));
  assert.deepEqual(s.violations, []);
  // One request beyond running plus queued is a violation: the session ends.
  adapter.receive(request('flood', LEASE));
  assert.deepEqual(s.violations, ['media streams']);
  assert.equal(s.listeners.size, 0);
  await waitUntil(() => source.state.inflight === 0, 'the pumps to stop');
  s.bulk = true;
  s.notify();
  for (let index = 0; index < 1000; index += 1) adapter.receive(request(`late${index}`, LEASE));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.sends.length, 1, 'a closed session sends nothing more');
  assert.equal(source.state.reads.length, max);
  assert.deepEqual(s.violations, ['media streams']);
});
