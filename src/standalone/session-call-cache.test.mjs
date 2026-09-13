import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createSessionCallCache } from './session-call-cache.mjs';

function fixture(overrides = {}) {
  let time = 1_000_000;
  const timers = new Set();
  const cache = createSessionCallCache({
    ttlMs: 100,
    maxEntries: 10,
    maxBytes: 1000,
    log() {},
    now: () => time,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    ...overrides,
  });
  return { cache, timers, advance: (ms) => { time += ms; } };
}

test('expiry begins at settlement, never while a mutation is still running', async () => {
  const f = fixture();
  const run = Promise.withResolvers();
  f.cache.track('call', run.promise, 'signature');
  assert.equal(f.timers.size, 0);
  f.advance(1000);
  assert.equal(f.cache.get('call').settled, false);
  run.resolve('done');
  await setImmediate();
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers][0];
  assert.equal(timer.delay, 100);
  timer.callback();
  assert.equal(f.cache.get('call'), undefined);
  assert.equal(f.cache.bytes, 0);
  assert.equal(f.timers.size, 0);
});

test('expired entries removed by pressure also release their old expiry timers', async () => {
  const f = fixture({ maxEntries: 1 });
  f.cache.track('old', Promise.resolve('old result'), 'old');
  await setImmediate();
  assert.equal(f.timers.size, 1);
  f.advance(101);
  const next = Promise.withResolvers();
  f.cache.track('new', next.promise, 'new');
  assert.equal(f.cache.get('old'), undefined);
  assert.equal(f.timers.size, 0);
  next.resolve('new result');
  await setImmediate();
  f.cache.close();
  assert.equal(f.timers.size, 0);
});

test('closing retires result storage and timers, including late settlements', async () => {
  const f = fixture();
  const late = Promise.withResolvers();
  f.cache.track('done', Promise.resolve('retained'), 'done');
  f.cache.track('late', late.promise, 'late');
  await setImmediate();
  assert.ok(f.cache.bytes > 0);
  f.cache.close();
  late.resolve('must not be retained');
  await setImmediate();
  f.cache.track('after-close', Promise.resolve('ignored'), 'ignored');
  assert.equal(f.cache.size, 0);
  assert.equal(f.cache.bytes, 0);
  assert.equal(f.timers.size, 0);
});

test('byte and entry pressure retain mutation identity instead of authorizing another execution', async () => {
  const f = fixture({ maxBytes: 30, maxEntries: 1 });
  f.cache.track('first', Promise.resolve('first'), 'one');
  await setImmediate();
  f.cache.track('second', Promise.resolve('second'), 'two');
  await setImmediate();
  assert.equal(f.cache.size, 2);
  assert.equal(f.cache.get('first').resultDropped, true);
  assert.equal(f.cache.get('first').signature, 'one');
  assert.equal(f.cache.get('first').promise, null);
  assert.equal(f.cache.get('second').resultDropped, false);
  assert.ok(f.cache.bytes <= 30);
  f.cache.close();
});

test('retained-size accounting preserves primitive, container, and cyclic result costs', async () => {
  const cycle = {};
  cycle.self = cycle;
  const values = [['string', 'hello', 26], ['array', [true, 3, 'x'], 86], ['object', { a: 'b' }, 100], ['cycle', cycle, 88]];
  const f = fixture();
  for (const [key, value] of values) f.cache.track(key, Promise.resolve(value), key);
  await setImmediate();
  for (const [key, , bytes] of values) assert.equal(f.cache.get(key).bytes, bytes, key);
  f.cache.close();
});

test('deeply nested results settle safely and obey the existing result-drop policy', async () => {
  const f = fixture({ maxBytes: 1000 });
  let value = 'deep';
  for (let i = 0; i < 20_000; i += 1) value = [value];
  f.cache.track('deep', Promise.resolve(value), 'deep');
  await setImmediate();
  assert.equal(f.cache.get('deep').settled, true);
  assert.equal(f.cache.get('deep').resultDropped, true);
  assert.equal(f.cache.bytes, 0);
  f.cache.close();
});

test('failed mutations keep their original rejection available during the retry lifetime', async () => {
  const f = fixture();
  const failure = new Error('mutation failed');
  const promise = Promise.reject(failure);
  f.cache.track('failed', promise, 'failed');
  await assert.rejects(f.cache.get('failed').promise, (error) => error === failure);
  await setImmediate();
  assert.equal(f.cache.get('failed').resultDropped, false);
  assert.equal(f.timers.size, 1);
  f.cache.close();
});

test('unreadable result properties retire only the cached result, never its mutation identity', async () => {
  const f = fixture();
  const value = { get unreadable() { throw new Error('result cannot be inspected'); } };
  const outcome = Promise.resolve(value);
  f.cache.track('unreadable', outcome, 'signature');
  assert.equal(await outcome, value);
  await setImmediate();
  assert.equal(f.cache.get('unreadable').settled, true);
  assert.equal(f.cache.get('unreadable').resultDropped, true);
  assert.equal(f.cache.get('unreadable').signature, 'signature');
  assert.equal(f.cache.bytes, 0);
  f.cache.close();
});
