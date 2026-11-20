// Server file uploads through the product's own pieces: the client library over a scripted core socket, the desktop's protocol
// connection, the production file IPC (and the attachment staging) and the upload coordinator attached to the connection. The
// core states `initialize.limits.maxUploadInFlightBytes`, applies one upload's chunks in arrival order and answers when told to.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect } from '../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../packages/protocol-client/src/mock.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { SERVER_UPLOAD_ALLOWANCE_MAX_BYTES } from '../shared/server-files.ts';
import { uploadFileToServer } from '../renderer/server-file-transfer.ts';
import { registerServerFileIpc } from './ipc-server-files.ts';
import { createProtocolConnection } from './protocol/connection.ts';
import { uploadServerBytes } from './server-file-access.ts';
import { ServerUploadCoordinator, serverUploadCoordinatorFor } from './server-upload-coordinator.ts';

const options = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const CHUNK = 193_536;
const ENCODED = (CHUNK / 3) * 4;
const WINDOW = 3 * 1024 * 1024;
const MAX_FRAME = 262_144;

const turns = async (count = 30) => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const file = (length, seed = 1) => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
};

/** A scripted core. It applies chunks in arrival order, answers them at once or holds the answers, and logs every frame. */
class Core {
  constructor(limits) {
    this.limits = limits;
    this.frames = [];
    this.held = [];
    this.hold = false;
    this.holdAbort = false;
    this.failAt = new Set();
    this.uploads = new Map();
    this.generations = 0;
  }

  attach(net) {
    void (async () => {
      for (;;) this.run(await net.accept());
    })();
  }

  run(conn) {
    const state = { counter: 0 };
    this.conn = conn;
    this.generations += 1;
    const instance = `s${this.generations}`;
    void (async () => {
      for (;;) {
        const text = await conn.nextSent();
        const frame = JSON.parse(text);
        if (frame.id === undefined) continue;
        this.frames.push({
          method: frame.method,
          params: frame.params,
          bytes: text.length,
          generation: this.generations,
        });
        this.answer(conn, state, instance, frame);
      }
    })();
  }

  answer(conn, state, instance, frame) {
    const reply = (result) => conn.serverSend({ id: frame.id, result });
    const refuse = (message) => conn.serverSend({ id: frame.id, error: { code: -32603, message } });
    switch (frame.method) {
      case 'initialize':
        return reply({ ...options.initializeResult, serverInstanceId: instance, limits: this.limits });
      case 'app/subscribe':
        reply({ subscription: { id: 'as', mode: 'snapshot', epoch: `ae-${instance}`, startSeq: 2 } });
        return conn.serverSend({
          method: 'app/snapshot',
          params: { sections: [] },
          feed: { id: 'app', epoch: `ae-${instance}`, seq: 1 },
        });
      case 'transfer/beginWrite': {
        state.counter += 1;
        const id = `t${state.counter}`;
        this.uploads.set(`${this.generations}:${id}`, {
          name: frame.params.name,
          size: frame.params.size,
          data: [],
          written: 0,
        });
        const answer = () => reply({ transferId: id, uploadId: id, maxBytes: 536_870_912 });
        if (!this.holdBegin) return answer();
        answer.kind = 'begin';
        return void this.held.push(answer);
      }
      case 'transfer/writeChunk': {
        const up = this.uploads.get(`${this.generations}:${frame.params.transferId}`);
        const bytes = Buffer.from(frame.params.bytesB64, 'base64');
        // The core applies a chunk when it arrives; only the answer is held.
        let failure = null;
        if (!up || this.failAt.has(frame.params.offset)) failure = 'disk full';
        else if (frame.params.offset !== up.written) failure = 'The upload chunk is out of order.';
        else {
          up.data.push(bytes);
          up.written += bytes.length;
        }
        const answer = () => (failure ? refuse(failure) : reply({}));
        answer.kind = 'write';
        if (this.hold) this.held.push(answer);
        else answer();
        return undefined;
      }
      case 'transfer/commit': {
        const up = this.uploads.get(`${this.generations}:${frame.params.transferId}`);
        this.frames.at(-1).heldAtCommit = this.held.length;
        return reply({ size: up.written, absolutePath: `/srv/stage/${up.name}`, name: up.name, dir: false });
      }
      case 'transfer/abort':
        if (this.holdAbort) {
          const answer = () => reply({ aborted: true });
          answer.kind = 'abort';
          return void this.held.push(answer);
        }
        return reply({ aborted: true });
      default:
        return reply({});
    }
  }

  writes(generation) {
    return this.frames.filter(
      (f) => f.method === 'transfer/writeChunk' && (generation === undefined || f.generation === generation)
    );
  }

  count(method) {
    return this.frames.filter((f) => f.method === method).length;
  }

  /** Answers held replies (all, or `count` of them), in order or reversed. */
  async release({ count = Infinity, reverse = false, kind } = {}) {
    const batch = [];
    for (const answer of [...this.held]) {
      if (batch.length >= count) break;
      if (kind === undefined || answer.kind === kind) {
        batch.push(answer);
        this.held.splice(this.held.indexOf(answer), 1);
      }
    }
    for (const answer of reverse ? batch.reverse() : batch) answer();
    await turns();
  }

  content(id, generation = this.generations) {
    return Buffer.concat(this.uploads.get(`${generation}:${id}`).data);
  }
}

async function target({ limits = {}, setup } = {}) {
  const core = new Core({ ...options.initializeResult.limits, maxUploadInFlightBytes: WINDOW, ...limits });
  setup?.(core);
  const net = new MockNetwork();
  core.attach(net);
  const connection = createProtocolConnection({
    open: () =>
      connect({
        target: { id: 'srv' },
        connector: net,
        clientInfo: options.clientInfo,
        capabilities: options.capabilities,
        clock: { sleep: () => Promise.resolve() },
        random: () => options.jitterUnit,
      }),
  });
  await connection.start();
  return { net, core, connection };
}

/** One window's production file IPC on `connection`, driven the way the renderer drives it. */
function windowOn(connection) {
  const handlers = new Map();
  const uploads = serverUploadCoordinatorFor(connection);
  const dispose = registerServerFileIpc({
    handle: (channel, run) => handlers.set(channel, run),
    server: {
      grants: { entry: (absolutePath, uploaded) => ({ ...uploaded, absolutePath, granted: true }) },
      downloads: {},
    },
    uploads,
    invokeDesktopOperation: async () => ({}),
    fileTarget: async () => ({}),
    projectDirectory: async () => '',
    shell: {},
  });
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args);
  const api = {
    serverUploadBegin: (name, size, scope) => call(DESKTOP_IPC.serverUploadBegin, name, size, scope),
    serverUploadChunk: (id, offset, bytes) => call(DESKTOP_IPC.serverUploadChunk, id, offset, bytes),
    serverUploadCommit: (id) => call(DESKTOP_IPC.serverUploadCommit, id),
    serverUploadAbort: (id) => call(DESKTOP_IPC.serverUploadAbort, id),
  };
  return { api, call, dispose, uploads };
}

const upload = (win, length, name = 'a.bin', extra = {}) =>
  uploadFileToServer(win.api, new File([file(length)], name), 'draft', extra);

test("with the core's normal limits exactly twelve full chunks are on the wire before the first reply, then it refills", async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const win = windowOn(connection);
  const done = upload(win, CHUNK * 20 + 7);
  await turns();
  assert.equal(core.writes().length, 12, 'twelve requests go out, no thirteenth');
  assert.ok(
    core.writes().every((f) => f.bytes <= MAX_FRAME),
    'every request fits the frame bound'
  );
  await core.release({ count: 1 });
  assert.equal(core.writes().length, 13, 'one reply refills one place');
  core.hold = false;
  await core.release();
  const entry = await done;
  assert.equal(entry.size, CHUNK * 20 + 7);
  assert.ok(Buffer.from(file(CHUNK * 20 + 7)).equals(core.content('t1')), 'byte for byte');
  assert.equal(core.frames.at(-1).heldAtCommit, 0, 'the commit follows the last acknowledgement');
  await connection.close();
});

test('attachment staging is paced by the same window', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const staged = uploadServerBytes(uploads, {}, file(CHUNK * 20), 'paste.png', 'transcript');
  await turns();
  assert.equal(core.writes().length, 12);
  core.hold = false;
  await core.release();
  assert.equal((await staged).size, CHUNK * 20);
  await connection.close();
});

test('a file just above the old failure size round-trips through the real frame bound', async () => {
  const { core, connection } = await target();
  const win = windowOn(connection);
  for (const length of [190 * 1024, 190 * 1024 + 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1]) {
    const entry = await upload(win, length, `f${length}.bin`);
    assert.equal(entry.size, length);
  }
  assert.ok(
    core.writes().every((f) => f.bytes <= MAX_FRAME),
    'no frame over maxInboundFrameBytes, final padding included'
  );
  await connection.close();
});

test('a 512 MiB upload takes at most 256 acknowledgement waves at the default window', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const owner = {};
  const size = 512 * 1024 * 1024;
  const { uploadId, chunkBytes, inFlightChunks } = await uploads.begin(owner, 'big.bin', size, 'draft');
  assert.equal(chunkBytes, CHUNK);
  assert.equal(inFlightChunks, 12);
  const chunk = new Uint8Array(chunkBytes);
  let waves = 0;
  let peak = 0;
  let offset = 0;
  const flights = new Set();
  while (offset < size || flights.size) {
    while (offset < size && flights.size < inFlightChunks) {
      const bytes = size - offset < chunkBytes ? new Uint8Array(size - offset) : chunk;
      const flight = uploads.write(owner, uploadId, offset, bytes).then(() => flights.delete(flight));
      flights.add(flight);
      offset += bytes.length;
    }
    await turns(4);
    peak = Math.max(peak, uploads.outstandingBytes);
    if (core.held.length) {
      waves += 1;
      await core.release();
    }
    await Promise.race([...flights, Promise.resolve()]);
  }
  assert.ok(waves <= 256, `${waves} waves`);
  assert.ok(peak <= WINDOW, 'never more than the window unanswered');
  assert.equal(core.count('transfer/writeChunk'), Math.ceil(size / CHUNK));
  uploads.abort(owner, uploadId);
  await connection.close();
});

test('two windows and the staging share one allowance on a target, a second target has its own, and an interactive call is never held', async () => {
  const first = await target({ setup: (c) => (c.hold = true) });
  const second = await target({ setup: (c) => (c.hold = true) });
  const a = windowOn(first.connection);
  const b = windowOn(first.connection);
  const staging = serverUploadCoordinatorFor(first.connection);
  const mine = windowOn(second.connection);
  const runs = [
    upload(a, CHUNK * 14, 'a.bin'),
    upload(b, CHUNK * 14, 'b.bin'),
    uploadServerBytes(staging, {}, file(CHUNK * 14), 'c.png', 'transcript'),
    upload(mine, CHUNK * 14, 'm.bin'),
  ];
  await turns(60);
  assert.equal(first.core.writes().length, 12, 'the first target holds twelve chunks in all, however many uploads ask');
  assert.ok(staging.outstandingBytes <= WINDOW, 'sent minus answered stays within the window');
  assert.equal(second.core.writes().length, 12, 'the second target has its own window');
  // The window is full, so the others' chunks wait; as replies come in, the places go round the uploads, not to one of them.
  await first.core.release({ count: 6 });
  await turns(60);
  const advanced = new Set(first.core.writes().map((f) => f.params.transferId));
  assert.equal(advanced.size, 3, 'under contention each upload advances');
  // An interactive call goes out while the upload credit is exhausted.
  const before = first.core.count('thread/read');
  const read = first.connection.call('thread/read', { threadId: 't', window: { lastItems: 1 } });
  await turns();
  assert.equal(first.core.count('thread/read'), before + 1, 'it was sent at once');
  await read;
  for (const t of [first, second]) {
    t.core.hold = false;
    await t.core.release();
  }
  await Promise.all(runs);
  const perTransfer = new Map();
  for (const f of first.core.writes())
    perTransfer.set(f.params.transferId, (perTransfer.get(f.params.transferId) ?? 0) + 1);
  assert.ok(
    [...perTransfer.values()].every((n) => n === 14),
    'every upload completed'
  );
  await first.connection.close();
  await second.connection.close();
});

test('a core that does not state its upload limits is refused at setup, nothing is sent', async () => {
  for (const [limits, message] of [
    [{ maxUploadInFlightBytes: undefined }, /valid upload window/],
    [{ maxBlobPutChunkBytes: undefined }, /upload chunk size/],
    [{ maxInboundFrameBytes: undefined }, /frame size/],
  ]) {
    const { core, connection } = await target({ limits });
    await assert.rejects(upload(windowOn(connection), 10), message);
    assert.equal(core.count('transfer/beginWrite'), 0, 'not even a begin');
    await connection.close();
  }
});

test("an unusable window is refused at setup, and one above this PC's ceiling is clamped", async () => {
  const bad = await target({ limits: { maxUploadInFlightBytes: 'lots' } });
  await assert.rejects(upload(windowOn(bad.connection), 10), /valid upload window/);
  await bad.connection.close();
  const small = await target({ limits: { maxUploadInFlightBytes: 1000 } });
  await assert.rejects(upload(windowOn(small.connection), 10), /smaller than one chunk/);
  await small.connection.close();
  const huge = await target({ limits: { maxUploadInFlightBytes: 10 ** 12 } });
  const { inFlightChunks } = await windowOn(huge.connection).api.serverUploadBegin('a.bin', CHUNK * 100, 'draft');
  assert.equal(
    inFlightChunks,
    Math.floor(SERVER_UPLOAD_ALLOWANCE_MAX_BYTES / ENCODED),
    'never a window as large as the file'
  );
  await huge.connection.close();
});

test('the chunk size is what the core advertises, cut to what the frame bound admits', async () => {
  const smaller = await target({ limits: { maxBlobPutChunkBytes: 90_000 } });
  assert.equal((await windowOn(smaller.connection).api.serverUploadBegin('a.bin', 10, 'draft')).chunkBytes, 90_000);
  await smaller.connection.close();
  const larger = await target({ limits: { maxBlobPutChunkBytes: 2 * 1024 * 1024 } });
  const entry = await upload(windowOn(larger.connection), 600_000);
  assert.equal(entry.size, 600_000);
  assert.ok(
    larger.core.writes().every((f) => f.bytes <= MAX_FRAME),
    'no oversized frame'
  );
  assert.equal((await windowOn(larger.connection).api.serverUploadBegin('b.bin', 10, 'draft')).chunkBytes, CHUNK);
  await larger.connection.close();
});

test('closing the connection retires the generation at once: held chunks are rejected and nothing more is sent', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const mine = {};
  const { uploadId } = await uploads.begin(mine, 'a.bin', CHUNK * 30, 'draft');
  const settled = [];
  for (let n = 0; n < 5; n += 1) {
    uploads.write(mine, uploadId, n * CHUNK, new Uint8Array(CHUNK)).then(
      () => settled.push('ok'),
      (e) => settled.push(e.message)
    );
  }
  await turns();
  assert.equal(uploads.outstandingBytes, 5 * ENCODED);
  const sent = core.frames.length;
  await connection.close();
  await turns();
  assert.equal(settled.length, 5, 'every held chunk was rejected');
  assert.ok(settled.every((m) => m !== 'ok'));
  assert.equal(uploads.outstandingBytes, 0, 'the generation is retired, not left to the next dispatch');
  assert.equal(core.frames.length, sent, 'nothing was sent after the close');
  await assert.rejects(uploads.write(mine, uploadId, 5 * CHUNK, new Uint8Array(CHUNK)), /gone/);
});

test('delayed and reordered replies give exact contents and monotone progress', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const progress = [];
  const run = upload(windowOn(connection), CHUNK * 30 + 5, 'a.bin', { onProgress: (sent) => progress.push(sent) });
  await turns();
  for (let round = 0; round < 40 && core.held.length; round += 1) await core.release({ reverse: true, count: 5 });
  core.hold = false;
  await core.release();
  await run;
  assert.ok(Buffer.from(file(CHUNK * 30 + 5)).equals(core.content('t1')));
  assert.deepEqual(
    progress,
    [...progress].sort((x, y) => x - y),
    'progress never goes back'
  );
  assert.equal(progress.at(-1), CHUNK * 30 + 5);
  await connection.close();
});

for (const [name, failAt] of [
  ['first', 0],
  ['a middle', CHUNK * 5],
  ['the last', CHUNK * 9],
]) {
  test(`a failure of ${name} chunk gives no commit, one cleanup, and the core's own error`, async () => {
    const { core, connection } = await target({ setup: (c) => c.failAt.add(failAt) });
    await assert.rejects(upload(windowOn(connection), CHUNK * 9 + 11), /disk full/);
    await turns();
    assert.equal(core.count('transfer/commit'), 0, 'never committed');
    assert.equal(core.count('transfer/abort'), 1, 'one cleanup attempt');
    await connection.close();
  });
}

test("main rejects an early commit, gaps, invalid sizes and another owner's handle", async () => {
  const { core, connection } = await target();
  const uploads = serverUploadCoordinatorFor(connection);
  const mine = {};
  const { uploadId } = await uploads.begin(mine, 'a.bin', CHUNK * 2, 'draft');
  await assert.rejects(uploads.commit(mine, uploadId), /not complete/, 'an early commit');
  await assert.rejects(uploads.write(mine, uploadId, CHUNK, new Uint8Array(10)), /offset is invalid/, 'a gap');
  await assert.rejects(
    uploads.write(mine, uploadId, 0, new Uint8Array(CHUNK + 1)),
    /chunk is invalid/,
    'a chunk over the size'
  );
  await assert.rejects(uploads.write(mine, uploadId, 0, new Uint8Array(0)), /chunk is invalid/);
  await uploads.write(mine, uploadId, 0, new Uint8Array(CHUNK));
  await uploads.write(mine, uploadId, CHUNK, new Uint8Array(CHUNK));
  await assert.rejects(
    uploads.write(mine, uploadId, 2 * CHUNK, new Uint8Array(1)),
    /offset is invalid/,
    'past the declared size'
  );
  await assert.rejects(uploads.commit({}, uploadId), /gone/, 'another owner');
  await assert.rejects(uploads.write({}, uploadId, 0, new Uint8Array(1)), /gone/);
  assert.equal(uploads.abort({}, uploadId), false, 'a foreign abort does nothing');
  assert.equal(uploads.abort(mine, uploadId), true);
  assert.equal(uploads.abort(mine, uploadId), false, 'a second abort sends nothing');
  await turns();
  assert.equal(core.count('transfer/abort'), 1, 'abort is idempotent');
  await connection.close();
});

test('a cancel drops unsent work at once, returns without waiting on a held reply, and the abort barrier releases the credit', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const mine = {};
  const { uploadId, inFlightChunks } = await uploads.begin(mine, 'a.bin', CHUNK * 40, 'draft');
  const settled = [];
  for (let n = 0; n < inFlightChunks; n += 1) {
    uploads.write(mine, uploadId, n * CHUNK, new Uint8Array(CHUNK)).then(
      () => settled.push('ok'),
      (e) => settled.push(e.message)
    );
  }
  await turns();
  assert.equal(uploads.outstandingBytes, 12 * ENCODED);
  core.holdAbort = true;
  const started = Date.now();
  assert.equal(uploads.abort(mine, uploadId), true);
  assert.ok(Date.now() - started < 50, 'cancel does not wait');
  await turns();
  assert.equal(settled.length, 12, 'every producer was rejected at once');
  assert.ok(settled.every((m) => /cancelled/.test(m)));
  assert.equal(uploads.outstandingBytes, 12 * ENCODED, 'the credit of chunks already sent stays charged');
  assert.equal(core.count('transfer/abort'), 1);
  core.holdAbort = false;
  await core.release();
  assert.equal(uploads.outstandingBytes, 0, 'the answered abort proves earlier writes drained');
  // Another upload proceeds, and is not charged twice for the old one.
  core.hold = false;
  const entry = await upload(windowOn(connection), CHUNK + 1);
  assert.equal(entry.size, CHUNK + 1);
  await connection.close();
});

test('an abort barrier that never answers retires the link at the deadline, and later uploads proceed on the reopened one', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const { timers, clock } = manualClock();
  let reopened = 0;
  const link = {
    get status() {
      return connection.status;
    },
    client: () => connection.client(),
    onEvent: (listener) => connection.onEvent(listener),
    reopen: () => {
      reopened += 1;
      return connection.reopen();
    },
  };
  const uploads = new ServerUploadCoordinator(link, { clock, deadlineMs: 30_000 });
  const mine = {};
  const { uploadId } = await uploads.begin(mine, 'a.bin', CHUNK * 4, 'draft');
  timers.length = 0;
  void uploads.write(mine, uploadId, 0, new Uint8Array(CHUNK)).catch(() => undefined);
  await turns();
  core.holdAbort = true;
  uploads.abort(mine, uploadId);
  await turns();
  const barrier = timers.filter(Boolean).at(-1);
  assert.equal(barrier.ms, 30_000);
  barrier.run();
  await turns();
  assert.equal(reopened, 1, 'the link was reopened, not reused');
  assert.equal(uploads.outstandingBytes, 0, 'the retired generation holds no credit');
  await turns(60);
  core.hold = false;
  const fresh = {};
  const next = await uploads.begin(fresh, 'b.bin', 10, 'draft');
  await uploads.write(fresh, next.uploadId, 0, new Uint8Array(10));
  assert.equal((await uploads.commit(fresh, next.uploadId)).size, 10);
  uploads.dispose();
  await connection.close();
});

test('a lost connection rejects held chunks, and a reconnect starts a fresh generation: no replay, no old handle on a reused id', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const mine = {};
  const first = await uploads.begin(mine, 'a.bin', CHUNK * 5, 'draft');
  const held = uploads.write(mine, first.uploadId, 0, new Uint8Array(CHUNK)).then(
    () => 'ok',
    (e) => e.message
  );
  await turns();
  const writesBefore = core.writes().length;
  core.limits = { ...core.limits, maxUploadInFlightBytes: 2 * ENCODED };
  core.hold = false;
  // The socket goes away; the client library redials and the core answers `initialize` with a smaller offer.
  core.conn.serverClose(1006);
  assert.match(await held, /interrupted|replaced|lost|gone/i, 'the held chunk is rejected');
  await turns(80);
  assert.equal(core.writes().length, writesBefore, 'nothing was replayed');
  await assert.rejects(uploads.write(mine, first.uploadId, CHUNK, new Uint8Array(CHUNK)), /gone/, 'an old handle');
  // A new upload on the new generation reuses remote id t1 and gets the smaller window.
  const second = await uploads.begin(mine, 'b.bin', CHUNK * 5, 'draft');
  assert.equal(second.inFlightChunks, 2, 'a fresh offer, not a stale minimum');
  assert.equal(core.frames.filter((f) => f.method === 'transfer/beginWrite').length, 2);
  await assert.rejects(uploads.commit(mine, first.uploadId), /gone/);
  uploads.abort(mine, second.uploadId);
  await connection.close();
});

test('a window closing cancels its own uploads only, and disposing the coordinator rejects the rest', async () => {
  const { core, connection } = await target({ setup: (c) => (c.hold = true) });
  const a = windowOn(connection);
  const b = windowOn(connection);
  const ra = upload(a, CHUNK * 20, 'a.bin').then(
    () => 'ok',
    (e) => e.message
  );
  const rb = upload(b, CHUNK * 20, 'b.bin');
  await turns(40);
  a.dispose();
  assert.match(await ra, /cancelled|gone/i);
  await turns();
  assert.equal(core.count('transfer/abort'), 1, "only a's upload was aborted");
  rb.catch(() => undefined);
  serverUploadCoordinatorFor(connection).dispose();
  await assert.rejects(rb);
  await connection.close();
});

// ---- one release object per flight and per pending begin ------------------------------------------------------------

const coordinatorOn = (connection, extra = {}) => {
  const link = {
    get status() {
      return connection.status;
    },
    client: () => connection.client(),
    onEvent: (listener) => connection.onEvent(listener),
    reopen: () => {
      if (extra.reopened) extra.reopened.count += 1;
      return connection.reopen();
    },
  };
  return new ServerUploadCoordinator(link, extra);
};

const holdAll = (c) => {
  c.hold = true;
  c.holdAbort = true;
};

const manualClock = () => {
  const timers = [];
  const clock = {
    setTimeout: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    clearTimeout: (h) => {
      timers[h - 1] = null;
    },
  };
  return { timers, clock };
};

test("a settled write's credit comes back once: an abort answered later cannot release it again and the window is never exceeded", async () => {
  const window = 2 * ENCODED;
  const { core, connection } = await target({
    limits: { maxUploadInFlightBytes: window },
    setup: holdAll,
  });
  const uploads = coordinatorOn(connection);
  const a = {};
  const b = {};
  const c = {};
  const up = await uploads.begin(a, 'a.bin', CHUNK * 4, 'draft');
  const waitingA = [0, 1].map((n) =>
    uploads.write(a, up.uploadId, n * CHUNK, new Uint8Array(CHUNK)).catch(() => 'cancelled')
  );
  await turns();
  assert.equal(uploads.outstandingBytes, window);
  uploads.abort(a, up.uploadId);
  await core.release({ count: 1, kind: 'write' });
  assert.equal(uploads.outstandingBytes, ENCODED, 'the settled write returned its credit');
  // Another upload spends the returned credit.
  const upB = await uploads.begin(b, 'b.bin', CHUNK * 4, 'draft');
  uploads.write(b, upB.uploadId, 0, new Uint8Array(CHUNK)).catch(() => undefined);
  await turns();
  assert.equal(uploads.outstandingBytes, window);
  assert.ok(uploads.outstandingBytes <= window);
  await core.release({ kind: 'abort' });
  assert.equal(
    uploads.outstandingBytes,
    ENCODED,
    'only the write the barrier proved drained was released, not the one already settled'
  );
  // The credit that is free is exactly one chunk: a second upload's chunks fill it and no more.
  uploads.write(b, upB.uploadId, CHUNK, new Uint8Array(CHUNK)).catch(() => undefined);
  const upC = await uploads.begin(c, 'c.bin', CHUNK * 4, 'draft');
  uploads.write(c, upC.uploadId, 0, new Uint8Array(CHUNK)).catch(() => undefined);
  await turns();
  assert.equal(uploads.outstandingBytes, window, 'never above the window');
  assert.equal(core.writes().length, 4, 'a third waiting chunk was not sent');
  await Promise.all(waitingA);
  uploads.dispose();
  await connection.close();
});

test('an answered abort barrier retires the deadlines of the writes it drained; an unanswered one keeps the reopen', async () => {
  const { core, connection } = await target({ setup: holdAll });
  const { timers, clock } = manualClock();
  const reopened = { count: 0 };
  const uploads = coordinatorOn(connection, { clock, reopened });
  const owner = {};
  const { uploadId } = await uploads.begin(owner, 'a.bin', CHUNK * 4, 'draft');
  for (let n = 0; n < 3; n += 1)
    uploads.write(owner, uploadId, n * CHUNK, new Uint8Array(CHUNK)).catch(() => undefined);
  await turns();
  uploads.abort(owner, uploadId);
  await turns();
  assert.ok(timers.filter(Boolean).length >= 4, 'three writes and the barrier each hold a deadline');
  await core.release({ kind: 'abort' });
  assert.equal(
    timers.filter(Boolean).length,
    0,
    'the answered barrier released every deadline of the writes it drained'
  );
  assert.equal(uploads.outstandingBytes, 0);
  assert.equal(reopened.count, 0, 'no later reopen interrupts anything');
  // Unanswered: the barrier keeps its deadline and the reopen.
  const next = await uploads.begin(owner, 'b.bin', CHUNK * 2, 'draft');
  uploads.write(owner, next.uploadId, 0, new Uint8Array(CHUNK)).catch(() => undefined);
  await turns();
  uploads.abort(owner, next.uploadId);
  await turns();
  timers.filter(Boolean).at(-1).run();
  await turns();
  assert.equal(reopened.count, 1);
  uploads.dispose();
  await connection.close();
});

test('a chunk failure retires the handle, detaches every producer and issues one abort itself', async () => {
  const { core, connection } = await target({
    setup: (c) => {
      c.hold = true;
      c.failAt.add(CHUNK);
    },
  });
  const uploads = coordinatorOn(connection);
  const owner = {};
  const { uploadId } = await uploads.begin(owner, 'a.bin', CHUNK * 6, 'draft');
  const settled = [];
  for (let n = 0; n < 4; n += 1) {
    uploads.write(owner, uploadId, n * CHUNK, new Uint8Array(CHUNK)).then(
      () => settled.push('ok'),
      (e) => settled.push(/disk full/.test(e.message) ? 'disk full' : e.message)
    );
  }
  await turns();
  await core.release({ count: 2, kind: 'write' });
  assert.deepEqual(
    settled,
    ['ok', 'disk full', 'disk full', 'disk full'],
    'every producer got the first error, at once'
  );
  assert.equal(core.count('transfer/abort'), 1, 'one keyed abort, issued by the coordinator');
  await assert.rejects(
    uploads.write(owner, uploadId, 4 * CHUNK, new Uint8Array(CHUNK)),
    /gone/,
    'the handle is retired'
  );
  await assert.rejects(uploads.commit(owner, uploadId), /gone/);
  assert.equal(uploads.abort(owner, uploadId), false, "the caller's own abort finds nothing left to do");
  core.hold = false;
  await core.release();
  assert.equal(uploads.outstandingBytes, 0, "the barrier's answer released the writes left");
  assert.equal(core.count('transfer/abort'), 1);
  uploads.dispose();
  await connection.close();
});

test('staging ends at the first chunk failure without waiting for the other writes', async () => {
  const { core, connection } = await target({
    setup: (c) => {
      c.hold = true;
      c.failAt.add(0);
    },
  });
  const uploads = serverUploadCoordinatorFor(connection);
  const staged = uploadServerBytes(uploads, {}, file(CHUNK * 8), 'p.png', 'transcript');
  staged.catch(() => undefined);
  await turns();
  await core.release({ count: 1, kind: 'write' });
  await assert.rejects(staged, /disk full/);
  assert.ok(
    core.held.some((answer) => answer.kind === 'write'),
    'other writes of the staging are still unanswered'
  );
  assert.equal(core.count('transfer/abort'), 1);
  await connection.close();
});

test('a begin is owned from the moment it is issued: an owner released meanwhile is rejected and its late answer is aborted', async () => {
  const { core, connection } = await target({ setup: (c) => (c.holdBegin = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const owner = {};
  const begun = uploads.begin(owner, 'a.bin', 10, 'draft');
  begun.catch(() => undefined);
  await turns();
  uploads.releaseOwner(owner);
  await assert.rejects(begun, /cancelled/);
  assert.equal(core.count('transfer/abort'), 0);
  await core.release({ kind: 'begin' });
  const aborts = core.frames.filter((f) => f.method === 'transfer/abort');
  assert.equal(aborts.length, 1, 'the late answer is aborted on the server, not installed');
  assert.equal(aborts[0].params.transferId, 't1');
  await connection.close();
});

test('concurrent begins share the capacity: only 64 reach the server', async () => {
  const { core, connection } = await target({ setup: (c) => (c.holdBegin = true) });
  const uploads = serverUploadCoordinatorFor(connection);
  const owners = Array.from({ length: 70 }, () => ({}));
  const results = owners.map((owner) =>
    uploads.begin(owner, 'a.bin', 10, 'draft').then(
      () => 'ok',
      (e) => e.message
    )
  );
  await turns(60);
  assert.equal(core.count('transfer/beginWrite'), 64);
  core.holdBegin = false;
  await core.release({ kind: 'begin' });
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter((m) => m === 'ok').length, 64);
  assert.equal(outcomes.filter((m) => /Too many/.test(m)).length, 6);
  for (const owner of owners) serverUploadCoordinatorFor(connection).releaseOwner(owner);
  await connection.close();
});

test('an owner released between the begin reply and its continuation leaves no live handle, one abort and no leaked slot', async () => {
  for (let hops = 0; hops <= 8; hops += 1) {
    const { core, connection } = await target({ setup: (c) => (c.holdBegin = true) });
    const uploads = serverUploadCoordinatorFor(connection);
    const owner = {};
    let begun = null;
    const outcome = uploads.begin(owner, 'a.bin', CHUNK * 2, 'draft').then(
      (value) => {
        begun = value;
        return 'begun';
      },
      (e) => e.message
    );
    await turns();
    // The reply arrives, and the owner is released `hops` microtask turns later: before, between or after the library's own
    // reactions and the coordinator's.
    const answer = core.held.splice(
      core.held.findIndex((a) => a.kind === 'begin'),
      1
    )[0];
    answer();
    let turn = Promise.resolve();
    for (let n = 0; n < hops; n += 1) turn = turn.then(() => undefined);
    await turn;
    uploads.releaseOwner(owner);
    await outcome;
    await turns();
    const aborts = core.frames.filter((f) => f.method === 'transfer/abort');
    assert.equal(
      aborts.length,
      1,
      `hops=${hops}: the transfer is aborted exactly once, by the release or as a late answer`
    );
    assert.equal(aborts[0].params.transferId, 't1');
    if (begun)
      await assert.rejects(
        uploads.write(owner, begun.uploadId, 0, new Uint8Array(1)),
        /gone|cancelled/,
        `hops=${hops}: no live handle`
      );
    // No capacity slot leaked: a full set of begins still passes.
    core.holdBegin = false;
    const others = Array.from({ length: 64 }, () =>
      uploads.begin({}, 'b.bin', 10, 'draft').then(
        () => 'ok',
        (e) => e.message
      )
    );
    assert.equal(
      (await Promise.all(others)).filter((m) => m === 'ok').length,
      64,
      `hops=${hops}: all 64 slots are free`
    );
    uploads.dispose();
    await connection.close();
  }
});
