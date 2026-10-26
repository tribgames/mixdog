import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyedReadCache } from './keyed-read-cache.ts';

/** A host read the test answers by hand, counting how many were made. */
function hostReads() {
  const pending = [];
  return {
    pending,
    reader: () => {
      const answer = Promise.withResolvers();
      pending.push(answer);
      return answer.promise;
    },
  };
}

test('a warm-up and the mounted list share one read in flight', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  const prefetch = cache.load('bot', host.reader);
  const mounted = cache.load('bot', host.reader);
  assert.equal(host.pending.length, 1, 'one host read for both');
  host.pending[0].resolve(['gmail']);
  assert.deepEqual(await prefetch, ['gmail']);
  assert.deepEqual(await mounted, ['gmail']);
  assert.deepEqual(cache.peek('bot'), ['gmail']);
});

test('each activation after the read settled revalidates, painting the cached value meanwhile', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  const first = cache.load('bot', host.reader);
  host.pending[0].resolve(['old']);
  await first;
  const again = cache.load('bot', host.reader);
  assert.equal(host.pending.length, 2, 'a new activation reads again');
  assert.deepEqual(cache.peek('bot'), ['old'], 'the cached value shows until the answer');
  host.pending[1].resolve(['new']);
  await again;
  assert.deepEqual(cache.peek('bot'), ['new']);
});

test('an older read answering after a write never replaces the written value', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  let notified = 0;
  cache.subscribe('bot', () => notified++);
  const read = cache.load('bot', host.reader);
  cache.write('bot', ['toggled off']);
  host.pending[0].resolve(['before the toggle']);
  await read;
  assert.deepEqual(cache.peek('bot'), ['toggled off']);
  assert.equal(notified, 1);
});

test('a change announced mid-read reads once more after it, and that newer answer wins', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  const stale = cache.load('bot', host.reader);
  const fresh = cache.refresh('bot', host.reader);
  const freshToo = cache.refresh('bot', host.reader);
  assert.equal(host.pending.length, 1, 'the follow-up waits for the read in flight');
  host.pending[0].resolve(['stale']);
  await stale;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.pending.length, 2, 'one follow-up for both announcements');
  host.pending[1].resolve(['fresh']);
  assert.deepEqual(await fresh, ['fresh']);
  assert.deepEqual(await freshToo, ['fresh']);
  assert.deepEqual(cache.peek('bot'), ['fresh']);
});

test('a failed read keeps the cached value and the next activation reads again', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  const first = cache.load('bot', host.reader);
  host.pending[0].resolve(['kept']);
  await first;
  const failing = cache.load('bot', host.reader);
  host.pending[1].reject(new Error('offline'));
  await assert.rejects(failing, /offline/);
  assert.deepEqual(cache.peek('bot'), ['kept']);
  void cache.load('bot', host.reader);
  assert.equal(host.pending.length, 3);
});

test('a key nobody subscribes to any more is dropped, and a revisit reads afresh', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  for (let index = 0; index < 100; index += 1) {
    const unsubscribe = cache.subscribe(`bot-${index}`, () => {});
    const read = cache.load(`bot-${index}`, host.reader);
    host.pending.at(-1).resolve([index]);
    await read;
    assert.deepEqual(cache.peek(`bot-${index}`), [index], 'kept while shown');
    unsubscribe();
    assert.equal(cache.peek(`bot-${index}`), undefined, 'dropped with its last subscriber');
  }
  const reads = host.pending.length;
  const unsubscribe = cache.subscribe('bot-0', () => {});
  const revisit = cache.load('bot-0', host.reader);
  assert.equal(host.pending.length, reads + 1, 'the revisit reads again');
  host.pending.at(-1).resolve(['again']);
  await revisit;
  assert.deepEqual(cache.peek('bot-0'), ['again']);
  unsubscribe();
});

test('a warm-up keeps its value for the list that mounts, and a read in flight at unsubscribe still ends dropped', async () => {
  const cache = createKeyedReadCache();
  const host = hostReads();
  const prefetch = cache.load('bot', host.reader);
  host.pending[0].resolve(['gmail']);
  await prefetch;
  const first = cache.subscribe('bot', () => {});
  const second = cache.subscribe('bot', () => {});
  first();
  assert.deepEqual(cache.peek('bot'), ['gmail'], 'another subscriber remains');
  const refreshed = cache.refresh('bot', host.reader);
  second();
  assert.deepEqual(cache.peek('bot'), ['gmail'], 'kept while its read is in flight');
  host.pending[1].resolve(['slack']);
  await refreshed;
  assert.equal(cache.peek('bot'), undefined);
});
