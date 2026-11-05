import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  CALL_WINDOW_BYTES,
  FrameDecoder,
  Kind,
  encodeFrame,
  encodeJsonFrame,
} from './frame.mjs';
import { runWorker } from './worker-core.mjs';

// Drives runWorker with in-memory pipes, as the core's pool would.
function harness(handlers, options = {}) {
  const input = new EventEmitter();
  const decoder = new FrameDecoder();
  const frames = [];
  const waiting = [];
  const exits = [];
  const deliver = () => {
    for (const waiter of waiting.splice(0)) waiter();
  };
  runWorker({
    handlers,
    input,
    write: (bytes) => {
      frames.push(...decoder.push(Buffer.from(bytes)));
      deliver();
    },
    exit: (code) => exits.push(code),
    ...options,
  });
  const until = async (predicate) => {
    while (!predicate()) await new Promise((resolve) => waiting.push(resolve));
  };
  const send = (kind, id, body) => input.emit('data', encodeFrame(kind, id, body));
  const call = (id, method, params = null, extra = {}) =>
    input.emit('data', encodeJsonFrame(Kind.CALL, id, { method, params, paths: [], thread: 't', ...extra }));
  const result = async (id) => {
    await until(() => frames.some((f) => f.kind === Kind.RESULT && f.id === id));
    return JSON.parse(frames.find((f) => f.kind === Kind.RESULT && f.id === id).body.toString());
  };
  const credit = (id, bytes) => {
    const body = Buffer.alloc(4);
    body.writeUInt32BE(bytes);
    send(Kind.CREDIT, id, body);
  };
  return { frames, exits, until, send, call, result, credit, input };
}

test('announces itself and runs a call to its result', async () => {
  const h = harness({ echo: async ({ params, thread }) => ({ value: { params, thread }, pin: true }) });
  assert.equal(h.frames[0].kind, Kind.READY);
  h.call(5, 'echo', { a: 1 });
  assert.deepEqual(await h.result(5), { ok: { params: { a: 1 }, thread: 't' }, pin: true });
});

test('an unknown method and a throwing handler are results, not crashes', async () => {
  const h = harness({
    boom: async () => {
      throw Object.assign(new Error('bad'), { code: 'E_BAD' });
    },
  });
  h.call(1, 'missing');
  assert.equal((await h.result(1)).err.code, 'unknown_method');
  h.call(2, 'boom');
  assert.deepEqual(await h.result(2), { err: { code: 'E_BAD', message: 'bad' }, pin: false });
  assert.deepEqual(h.exits, []);
});

test('chunks stop at the window and resume on credit', async () => {
  const total = CALL_WINDOW_BYTES * 2;
  const h = harness({ big: async ({ emit }) => (await emit(Buffer.alloc(total, 1)), { value: 'done' }) });
  h.call(1, 'big');
  const sent = () => h.frames.filter((f) => f.kind === Kind.CHUNK).reduce((n, f) => n + f.body.length, 0);
  await h.until(() => sent() === CALL_WINDOW_BYTES);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent(), CALL_WINDOW_BYTES, 'the worker waits for credit');
  assert.ok(!h.frames.some((f) => f.kind === Kind.RESULT));
  h.credit(1, CALL_WINDOW_BYTES);
  assert.deepEqual(await h.result(1), { ok: 'done', pin: false });
  assert.equal(sent(), total);
});

test('cancel aborts the call and the answer is `cancelled`', async () => {
  const h = harness({
    hold: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ value: 'late' }))),
  });
  h.call(1, 'hold');
  h.send(Kind.CANCEL, 1);
  assert.equal((await h.result(1)).err.code, 'cancelled');
});

test('a cancel stops a call that waits for the shared browser', async () => {
  const h = harness({ page: async ({ requestBrowser }) => ({ value: await requestBrowser() }) });
  h.call(1, 'page');
  await h.until(() => h.frames.some((f) => f.kind === Kind.NEED_BROWSER && f.id === 1));
  h.send(Kind.CANCEL, 1);
  assert.equal((await h.result(1)).err.code, 'cancelled');
});

test('the browser endpoint the core answers reaches the handler', async () => {
  const h = harness({ page: async ({ requestBrowser }) => ({ value: await requestBrowser() }) });
  h.call(1, 'page');
  await h.until(() => h.frames.some((f) => f.kind === Kind.NEED_BROWSER));
  h.send(Kind.BROWSER, 1, Buffer.from(JSON.stringify({ ws: 'ws://x/y' })));
  assert.deepEqual(await h.result(1), { ok: 'ws://x/y', pin: false });
  const refused = harness({ page: async ({ requestBrowser }) => ({ value: await requestBrowser() }) });
  refused.call(2, 'page');
  await refused.until(() => refused.frames.some((f) => f.kind === Kind.NEED_BROWSER));
  refused.send(Kind.BROWSER, 2, Buffer.from(JSON.stringify({ error: 'no chrome' })));
  assert.deepEqual(await refused.result(2), { err: { code: 'browser_unavailable', message: 'no chrome' }, pin: false });
});

test('bye and a closed pipe end the process; a second call while busy is a protocol error', async () => {
  const bye = harness({});
  bye.send(Kind.BYE, 0);
  assert.deepEqual(bye.exits, [0]);
  const closed = harness({});
  closed.input.emit('end');
  assert.deepEqual(closed.exits, [0]);
  const busy = harness({ hold: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve)) });
  busy.call(1, 'hold');
  busy.call(2, 'hold');
  assert.deepEqual(busy.exits, [2]);
});
