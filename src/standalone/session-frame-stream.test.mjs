import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSessionFrameStream } from './session-frame-stream.mjs';

class Response extends EventEmitter {
  writes = [];
  results = [];
  ended = false;
  failData = false;
  failEnd = false;
  writeHead() {}
  write(value) {
    if (this.failData && value.startsWith('data:')) throw new Error('stream unavailable');
    this.writes.push(value);
    return this.results.length ? this.results.shift() : true;
  }
  end() {
    this.ended = true;
    if (this.failEnd) throw new Error('end unavailable');
    this.emit('close');
  }
  frames() {
    return this.writes
      .flatMap((value) => value.split('\n\n'))
      .filter((event) => event.startsWith('data:'))
      .map((event) => JSON.parse(event.slice(6)));
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let closed = 0;
  const clients = new Map([
    [
      'client',
      {
        sse: null,
        paused: false,
        pending: new Map(),
        pendingBytes: 0,
      },
    ],
  ]);
  const stream = createSessionFrameStream({
    clients,
    maxPendingBytes: 1024 * 1024,
    nowMs: () => 123,
    onAttached() {},
    onClosed: () => {
      closed += 1;
    },
  });
  return { stream, closed: () => closed };
}

test('attachment backpressure defers the backlog until drain', (t) => {
  const { stream } = fixture(t);
  const frame = { type: 'session-state', sessionId: 'demo', revision: 1 };
  stream.broadcast(frame);
  const response = new Response();
  response.results = [false, true];
  stream.attachSse('client', response);
  assert.deepEqual(response.frames(), []);
  response.emit('drain');
  assert.deepEqual(response.frames(), [frame]);
});

test('keepalives do not write while the response is backpressured', (t) => {
  const { stream } = fixture(t);
  const response = new Response();
  response.results = [true, false];
  stream.attachSse('client', response);
  stream.broadcast({ type: 'update' });
  t.mock.timers.tick(45_000);
  assert.equal(response.writes.length, 2);
});

test('keepalive backpressure also defers subsequent state frames', (t) => {
  const { stream } = fixture(t);
  const response = new Response();
  response.results = [true, false, true];
  stream.attachSse('client', response);
  t.mock.timers.tick(15_000);
  const frame = { type: 'update' };
  stream.broadcast(frame);
  assert.deepEqual(response.frames(), []);
  response.emit('drain');
  assert.deepEqual(response.frames(), [frame]);
});

for (const failEnd of [false, true]) {
  test(`replacement retires the old response and heartbeat even when end throws=${failEnd}`, (t) => {
    const { stream, closed } = fixture(t);
    const old = new Response();
    old.failEnd = failEnd;
    stream.attachSse('client', old);
    const next = new Response();
    stream.attachSse('client', next);
    t.mock.timers.tick(30_000);
    assert.equal(old.ended, true);
    assert.equal(old.writes.length, 1);
    assert.equal(next.writes.length, 3);
    old.emit('error', new Error('late old-stream error'));
    const frame = { type: 'update' };
    stream.broadcast(frame);
    assert.deepEqual(next.frames(), [frame]);
    assert.equal(closed(), 1);
  });
}

for (const queued of [false, true]) {
  test(`failed ${queued ? 'backlog' : 'live'} writes retire the response and preserve the frame`, (t) => {
    const { stream, closed } = fixture(t);
    const old = new Response();
    const frame = { type: 'update' };
    old.failData = true;
    if (queued) stream.broadcast(frame);
    stream.attachSse('client', old);
    if (!queued) stream.broadcast(frame);
    assert.equal(old.ended, true);
    assert.equal(closed(), 1);
    const next = new Response();
    stream.attachSse('client', next);
    assert.deepEqual(next.frames(), [frame]);
  });
}

test('error and close retire one response exactly once', (t) => {
  const { stream, closed } = fixture(t);
  const response = new Response();
  stream.attachSse('client', response);
  response.emit('error', new Error('connection closed'));
  response.emit('close');
  t.mock.timers.tick(30_000);
  assert.equal(closed(), 1);
  assert.equal(response.writes.length, 1);
});

test('traced backlog reports queue duration and desktop-frame resync without altering delivery', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1_000;
  const diagnostics = [];
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes: 1_024,
    nowMs: () => now,
    onAttached() {},
    onClosed() {},
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const response = new Response();
  response.results = [false];
  stream.attachSse('client', response);
  for (const sessionId of ['A', 'B']) {
    stream.broadcast({
      type: 'desktop-event',
      key: `session:${sessionId}`,
      desktopId: 'desktop',
      message: {
        kind: 'session-state',
        sessionId,
        readTraceId: `read-${sessionId}`,
        wire: { items: [{ text: 'private data '.repeat(50) }] },
      },
    });
  }
  assert.equal(diagnostics.find((r) => r.stage === 'stream-resync-marker').sessionId, 'A');
  assert.equal(
    diagnostics.some((r) => r.stage === 'stream-dropped'),
    false
  );
  now = 1_750;
  response.emit('drain');
  assert.deepEqual(
    response.frames().map((f) => [f.message.sessionId, f.message.resyncRequired === true]),
    [
      ['A', true],
      ['B', false],
    ]
  );
  const sent = diagnostics.find((r) => r.stage === 'stream-write');
  assert.equal(sent.queuedMs, 750);
  assert.equal(sent.traceId, 'read-B');
  assert.equal(JSON.stringify(diagnostics).includes('private data'), false);
  response.end();
});

test('a single frame larger than the cap is delivered when the queue is empty', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const diagnostics = [];
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes: 8 * 1024 * 1024,
    nowMs: () => 1_000,
    onAttached() {},
    onClosed() {},
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const frame = { type: 'session-state', sessionId: 'big', full: { text: 'x'.repeat(10 * 1024 * 1024) } };
  stream.broadcast(frame);
  assert.equal(
    diagnostics.some((r) => r.stage === 'stream-dropped' || r.stage === 'stream-resync-marker'),
    false
  );
  const response = new Response();
  stream.attachSse('client', response);
  assert.deepEqual(response.frames(), [frame]);
  assert.equal(client.pendingBytes, 0);
  response.end();
});

test('an oversize backlog turns a wrapped desktop session-state frame into a resync marker', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes: 1_024,
    nowMs: () => 1_000,
    onAttached() {},
    onClosed() {},
  });
  const wrapped = (sessionId, text) => ({
    type: 'desktop-event',
    key: `desktop-event:desktop:session-state:${sessionId}`,
    desktopId: 'desktop',
    message: { kind: 'session-state', sessionId, wire: { items: [{ text }] } },
  });
  stream.broadcast(wrapped('A', 'a'.repeat(700)));
  const large = wrapped('B', 'b'.repeat(4_000));
  stream.broadcast(large);
  const response = new Response();
  stream.attachSse('client', response);
  assert.deepEqual(response.frames(), [
    {
      type: 'desktop-event',
      key: 'desktop-event:desktop:session-state:A',
      desktopId: 'desktop',
      message: {
        kind: 'session-state',
        sessionId: 'A',
        resyncRequired: true,
        wire: { __itemsPatch: { base: -2, revision: -1 } },
      },
    },
    large,
  ]);
  response.end();
});

test('broadcast skips serialization when no SSE client is a target', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let serialized = 0;
  const frame = {
    type: 'desktop-event',
    toJSON() {
      serialized += 1;
      return { type: 'desktop-event' };
    },
  };
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const options = { maxPendingBytes: 1_024, nowMs: () => 1_000, onAttached() {}, onClosed() {} };
  createSessionFrameStream({ clients: new Map(), ...options }).broadcast(frame);
  const stream = createSessionFrameStream({ clients: new Map([['client', client]]), ...options });
  stream.broadcast(frame, ['in-process']);
  stream.broadcast(frame, []);
  assert.equal(serialized, 0);
  assert.equal(client.pending.size, 0);
  stream.broadcast(frame, ['client']);
  assert.equal(serialized, 1);
});

function laneStream(t, { maxPendingBytes = 8 * 1024 * 1024, onDiagnostic } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes,
    nowMs: () => 1_000,
    onAttached() {},
    onClosed() {},
    onDiagnostic,
  });
  const response = new Response();
  // Backpressured from the attach: every frame below is queued until drain.
  response.results = [false];
  stream.attachSse('client', response);
  return { client, stream, response };
}

const laneFull = (sessionId, revision, text, readTraceId) => ({
  type: 'desktop-event',
  key: `desktop-event:desktop:session-state:${sessionId}`,
  desktopId: 'desktop',
  message: {
    kind: 'session-state',
    sessionId,
    ...(readTraceId ? { readTraceId } : {}),
    wire: { items: [text], __itemsRevision: revision },
  },
});
const lanePatch = (sessionId, revision, text) => ({
  type: 'desktop-event',
  key: `desktop-event:desktop:session-state:${sessionId}`,
  desktopId: 'desktop',
  message: {
    kind: 'session-state',
    sessionId,
    wire: { __itemsPatch: { base: revision - 1, revision, prefix: 1, append: [text] } },
  },
});

/** The desktop decoder's contract: a patch applies only to the revision held. */
function laneReceiver() {
  const held = new Map();
  const resyncs = [];
  return {
    resyncs,
    held,
    receive(frames) {
      for (const frame of frames) {
        const { sessionId, wire } = frame.message;
        const patch = wire?.__itemsPatch;
        if (!patch) {
          held.set(sessionId, wire.__itemsRevision);
        } else if (patch.base === held.get(sessionId)) {
          held.set(sessionId, patch.revision);
        } else {
          held.delete(sessionId);
          resyncs.push(sessionId);
        }
      }
    },
  };
}

test('a patch queued behind its full snapshot leaves with it instead of replacing it', (t) => {
  const diagnostics = [];
  const { client, stream, response } = laneStream(t, { onDiagnostic: (entry) => diagnostics.push(entry) });
  const full = laneFull('B', 1, 'b'.repeat(300_000), 'read-B');
  const patch = lanePatch('B', 2, 'live');
  stream.broadcast(full);
  stream.broadcast(patch);
  // A full snapshot is self-contained, so it still replaces a queued chain.
  const restartC = laneFull('C', 1, 'restart');
  stream.broadcast(laneFull('C', 1, 'old'));
  stream.broadcast(lanePatch('C', 2, 'z'));
  stream.broadcast(restartC);
  response.emit('drain');
  assert.deepEqual(response.frames(), [full, patch, restartC]);
  const receiver = laneReceiver();
  receiver.receive(response.frames());
  assert.deepEqual(receiver.resyncs, []);
  assert.equal(receiver.held.get('B'), 2);
  assert.equal(
    diagnostics.some((r) => r.stage === 'stream-replaced' && r.sessionId === 'B'),
    false
  );
  assert.equal(diagnostics.find((r) => r.stage === 'stream-write')?.traceId, 'read-B');
  assert.equal(client.pendingBytes, 0);
  response.end();
});

test('a lane resync is not re-sent each cycle while the stream is backed up', (t) => {
  const { stream, response } = laneStream(t);
  const receiver = laneReceiver();
  // The service answers each resync with the full lane, and a live update
  // follows it before the backlog drains.
  const publishLane = () => {
    stream.broadcast(laneFull('A', 1, 'a'.repeat(1024 * 1024)));
    stream.broadcast(lanePatch('A', 2, 'tick'));
  };
  publishLane();
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = response.frames().length;
    response.results = [false];
    response.emit('drain');
    receiver.receive(response.frames().slice(before));
    if (receiver.resyncs.length <= cycle) break;
    publishLane();
  }
  assert.deepEqual(receiver.resyncs, []);
  assert.equal(receiver.held.get('A'), 2);
  assert.equal(response.frames().filter((f) => !f.message.wire.__itemsPatch).length, 1);
  response.end();
});

test('a queued resync marker absorbs the patches issued after it', (t) => {
  const { client, stream, response } = laneStream(t, { maxPendingBytes: 1_024 });
  stream.broadcast(laneFull('A', 1, 'a'.repeat(700)));
  // B pushes the backlog over the cap: A collapses to a marker.
  const fullB = laneFull('B', 1, 'b'.repeat(4_000));
  stream.broadcast(fullB);
  stream.broadcast(lanePatch('A', 2, 'y'));
  response.emit('drain');
  assert.deepEqual(
    response.frames().map((f) => [f.message.sessionId, f.message.resyncRequired === true]),
    [
      ['A', true],
      ['B', false],
    ]
  );
  assert.deepEqual(response.frames()[1], fullB);
  assert.equal(client.pendingBytes, 0);
  response.end();
});

test('the backlog cap still bounds patch chains', (t) => {
  const { client, stream, response } = laneStream(t, { maxPendingBytes: 1_024 });
  stream.broadcast(laneFull('A', 1, 'a'.repeat(400)));
  for (let revision = 2; revision < 12; revision++) stream.broadcast(lanePatch('A', revision, 'p'.repeat(40)));
  const fullB = laneFull('B', 1, 'b'.repeat(300));
  stream.broadcast(fullB);
  const queued = [...client.pending.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  assert.equal(client.pendingBytes, queued);
  assert.ok(client.pendingBytes <= 1_024);
  response.emit('drain');
  assert.deepEqual(
    response.frames().map((f) => [f.message.sessionId, f.message.resyncRequired === true]),
    [
      ['A', true],
      ['B', false],
    ]
  );
  response.end();
});

test('a session-state patch frame queued behind its full frame is delivered after it', (t) => {
  const { stream, response } = laneStream(t);
  const full = { type: 'session-state', key: 'session-state:S', sessionId: 'S', revision: 1, full: { items: [] } };
  const patch = {
    type: 'session-state',
    key: 'session-state:S',
    sessionId: 'S',
    revision: 2,
    baseRevision: 1,
    patch: { set: { title: 't' } },
  };
  stream.broadcast(full);
  stream.broadcast(patch);
  response.emit('drain');
  assert.deepEqual(response.frames(), [full, patch]);
  response.end();
});

test('a stream paused past a keepalive period reports what is still buffered', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1_000;
  const diagnostics = [];
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes: 1_024,
    nowMs: () => now,
    onAttached() {},
    onClosed() {},
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const response = new Response();
  response.writableLength = 4_096;
  response.writableNeedDrain = true;
  response.results = [true, false];
  stream.attachSse('client', response);
  stream.broadcast({ type: 'update' });
  now += 15_000;
  t.mock.timers.tick(15_000);
  assert.deepEqual(diagnostics, [
    {
      stage: 'stream-stalled',
      atMs: 16_000,
      pausedMs: 15_000,
      bufferedBytes: 4_096,
      needDrain: true,
      pendingBytes: 0,
      maxPendingBytes: 1_024,
    },
  ]);
  response.end();
});

test('stream diagnostics are rate bounded and throwing sinks cannot block writes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const diagnostics = [];
  let now = 1_000;
  const client = { sse: null, paused: false, pending: new Map(), pendingBytes: 0 };
  const stream = createSessionFrameStream({
    clients: new Map([['client', client]]),
    maxPendingBytes: 1_024,
    nowMs: () => now,
    onAttached() {},
    onClosed() {},
    onDiagnostic(entry) {
      diagnostics.push(entry);
      throw new Error('sink unavailable');
    },
  });
  const response = new Response();
  stream.attachSse('client', response);
  const frame = { type: 'session-state', sessionId: 'A', readTraceId: 'read-A' };
  for (let i = 0; i < 100; i++) stream.broadcast(frame);
  assert.equal(response.frames().length, 100);
  assert.equal(diagnostics.length, 40);
  now += 10_000;
  stream.broadcast(frame);
  assert.equal(diagnostics.length, 41);
  assert.equal(diagnostics.at(-1).suppressed, 60);
  response.end();
});
