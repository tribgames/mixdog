import assert from 'node:assert/strict';
import test from 'node:test';
import { createInFlightJoin, createProviderModelsCache, PROVIDER_MODELS_REUSE_MS } from './provider-models-cache.ts';

function harness() {
  const clock = { now: 1_000 };
  const cache = createProviderModelsCache({ now: () => clock.now });
  const calls = [];
  const gates = [];
  const read = (options = {}) =>
    cache.read(options, () => {
      calls.push(options);
      const gate = Promise.withResolvers();
      gates.push(gate);
      return gate.promise;
    });
  const settle = (value) => gates.shift().resolve(value);
  return { clock, cache, calls, gates, read, settle };
}

test('concurrent full catalog reads share one daemon load, and the answer is reused while fresh', async () => {
  const h = harness();
  const reads = [h.read(), h.read({ quick: false }), h.read()];
  assert.equal(h.calls.length, 1, 'boot-time callers join the one load');
  h.settle(['catalog']);
  assert.deepEqual(await Promise.all(reads), [['catalog'], ['catalog'], ['catalog']]);
  assert.deepEqual(await h.read(), ['catalog']);
  assert.equal(h.calls.length, 1);
  h.clock.now += PROVIDER_MODELS_REUSE_MS;
  const stale = h.read();
  assert.equal(h.calls.length, 2, 'past the window the daemon is asked again');
  h.settle(['next']);
  assert.deepEqual(await stale, ['next']);
});

test('a forced read always goes out and becomes the answer; quick reads are never reused', async () => {
  const h = harness();
  const first = h.read();
  h.settle(['old']);
  await first;
  const forced = h.read({ force: true });
  assert.equal(h.calls.length, 2);
  h.settle(['fresh']);
  assert.deepEqual(await forced, ['fresh']);
  assert.deepEqual(await h.read(), ['fresh']);
  const quick = h.read({ quick: true });
  assert.equal(h.calls.length, 3);
  h.settle(['quick']);
  assert.deepEqual(await quick, ['quick']);
  assert.deepEqual(await h.read(), ['fresh'], 'a quick answer never replaces the full one');
});

test('clear() drops the answer and keeps a read begun before it from becoming one', async () => {
  const h = harness();
  const before = h.read();
  h.cache.clear();
  const after = h.read();
  assert.equal(h.calls.length, 2, 'a caller after the change does not join the earlier load');
  h.settle(['before-change']);
  h.settle(['after-change']);
  assert.deepEqual(await before, ['before-change']);
  assert.deepEqual(await after, ['after-change']);
  assert.deepEqual(await h.read(), ['after-change']);
  assert.equal(h.calls.length, 2);
});

test('an ordinary load finishing after a newer forced refresh never replaces it', async () => {
  const h = harness();
  const ordinary = h.read();
  const forced = h.read({ refresh: true });
  assert.equal(h.calls.length, 2);
  const [olderGate, refreshGate] = h.gates.splice(0);
  refreshGate.resolve(['refreshed']);
  assert.deepEqual(await forced, ['refreshed']);
  olderGate.resolve(['older']);
  assert.deepEqual(await ordinary, ['older'], 'its own caller still gets its answer');
  assert.deepEqual(await h.read(), ['refreshed'], 'the refresh stays the answer');
  assert.equal(h.calls.length, 2);
});

test('a partial catalog is reused only until its retry time, clamped to 1-30 s; a later complete one is kept', async () => {
  const h = harness();
  const partial = (retryAt) => [
    {
      id: 'm',
      catalogPartial: true,
      catalogMissing: ['slow'],
      ...(retryAt === undefined ? {} : { catalogRetryAt: retryAt }),
    },
  ];
  const answer = async (value, options) => {
    const reading = h.read(options);
    h.settle(value);
    return reading;
  };

  // Retry in 5 s: reused until then, then asked again.
  await answer(partial(h.clock.now + 5_000));
  h.clock.now += 4_999;
  await h.read();
  assert.equal(h.calls.length, 1, 'reused before catalogRetryAt');
  h.clock.now += 1;
  const complete = [{ id: 'm' }, { id: 'n' }];
  assert.deepEqual(await answer(complete), complete);
  assert.equal(h.calls.length, 2, 'asked again at catalogRetryAt');

  // The complete answer gets the full window.
  h.clock.now += PROVIDER_MODELS_REUSE_MS - 1;
  assert.deepEqual(await h.read(), complete);
  assert.equal(h.calls.length, 2, 'a complete answer is kept for the full window');

  // A past (or missing) retry time still holds for 1 s; a far one at most 30 s.
  for (const [retryAt, holds] of [
    [h.clock.now - 10_000, 1_000],
    [undefined, 1_000],
    [h.clock.now + 600_000, PROVIDER_MODELS_REUSE_MS],
  ]) {
    h.cache.clear();
    const calls = h.calls.length;
    const base = h.clock.now;
    const kept = partial(retryAt);
    await answer(kept);
    h.clock.now = base + holds - 1;
    assert.deepEqual(await h.read(), kept, `held for ${holds} ms`);
    assert.equal(h.calls.length, calls + 1);
    h.clock.now = base + holds;
    const next = h.read();
    assert.equal(h.calls.length, calls + 2, `asked again after ${holds} ms`);
    h.settle(complete);
    await next;
  }
});

test('a failed load is not kept and later callers retry', async () => {
  const cache = createProviderModelsCache();
  let runs = 0;
  const boom = () => {
    runs += 1;
    return Promise.reject(new Error('offline'));
  };
  await assert.rejects(Promise.all([cache.read({}, boom), cache.read({}, boom)]), /offline/);
  await assert.rejects(cache.read({}, boom), /offline/);
  assert.equal(runs, 2, 'joined while running, retried after failing');
  const join = createInFlightJoin();
  assert.equal(await join.run('k', async () => 'value'), 'value');
});
