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
    return this.writes.filter((value) => value.startsWith('data:')).map((value) => JSON.parse(value.slice(6)));
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
