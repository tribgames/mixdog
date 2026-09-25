import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStoredTranscriptCache, nextProjectionStamp } from './store-transcript-cache.mjs';

const stat = (mtimeMs, size) => ({ mtimeMs, ctimeMs: mtimeMs, size, ino: 1, dev: 1 });
const text = (value) => () => value;

test('identical content shares one projection; changed content or sidecar re-parses', async () => {
  const cache = createStoredTranscriptCache();
  let produced = 0;
  const produce = () => {
    produced += 1;
    return { items: [produced] };
  };
  const base = { key: 'a|512', fingerprint: 'absent', fileStat: stat(1, 10), now: 5 };
  const first = await cache.read({ ...base, loadText: text('{"id":"a"}'), produce });
  const again = await cache.read({ ...base, loadText: text('{"id":"a"}'), produce });
  assert.equal(first.hit, false);
  assert.equal(again.hit, true);
  assert.equal(again.read, true);
  assert.equal(again.value, first.value);
  const changed = await cache.read({ ...base, loadText: text('{"id":"a","x":1}'), produce });
  assert.equal(changed.hit, false);
  assert.notEqual(changed.value, first.value);
  const sidecar = await cache.read({
    ...base,
    fingerprint: 'present:1:9',
    loadText: text('{"id":"a","x":1}'),
    produce,
  });
  assert.equal(sidecar.hit, false);
  assert.equal(produced, 3);
});

test('same-length text changes remain distinct, including lone UTF-16 surrogates', async () => {
  const cache = createStoredTranscriptCache();
  const base = { key: 'unicode', fingerprint: 'absent', fileStat: stat(1, 1), now: 5 };
  let produced = 0;
  const produce = (body) => ({ codeUnit: body.charCodeAt(0), revision: ++produced });
  for (const body of ['\ud800', '\ud801', '\ufffd', '가', '나']) {
    const changed = await cache.read({ ...base, loadText: text(body), produce });
    assert.equal(changed.hit, false);
    assert.equal(changed.value.codeUnit, body.charCodeAt(0));
    const same = await cache.read({
      ...base,
      loadText: text(String.fromCharCode(body.charCodeAt(0))),
      produce,
    });
    assert.equal(same.hit, true);
    assert.equal(same.value, changed.value);
  }
  assert.equal(produced, 5);
});

test('a settled file whose stat still matches is trusted without reading its body', async () => {
  const cache = createStoredTranscriptCache();
  const produce = () => ({ items: [] });
  let loads = 0;
  const loadText = () => {
    loads += 1;
    return 'body';
  };
  const first = await cache.read({
    key: 'c',
    fingerprint: 'absent',
    fileStat: stat(1_000, 4),
    now: 1_500,
    loadText,
    produce,
  });
  assert.equal(first.hit, false);
  // Too fresh: a same-stamp rewrite is still possible, so the body is compared.
  const fresh = await cache.read({
    key: 'c',
    fingerprint: 'absent',
    fileStat: stat(1_000, 4),
    now: 2_000,
    loadText,
    produce,
  });
  assert.equal(fresh.hit, true);
  assert.equal(fresh.read, true);
  const settled = await cache.read({
    key: 'c',
    fingerprint: 'absent',
    fileStat: stat(1_000, 4),
    now: 10_000,
    loadText,
    produce,
  });
  assert.equal(settled.hit, true);
  assert.equal(settled.read, false);
  assert.equal(loads, 2);
  // A different stat always reads, and a different sidecar never trusts stat.
  const moved = await cache.read({
    key: 'c',
    fingerprint: 'absent',
    fileStat: stat(1_001, 4),
    now: 10_000,
    loadText,
    produce,
  });
  assert.equal(moved.read, true);
  const sidecar = await cache.read({
    key: 'c',
    fingerprint: 'present:1:1',
    fileStat: stat(1_001, 4),
    now: 10_000,
    loadText,
    produce,
  });
  assert.equal(sidecar.hit, false);
});

test('concurrent readers of the same content wait for one parse', async () => {
  const cache = createStoredTranscriptCache();
  let produced = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const produce = async () => {
    produced += 1;
    await gate;
    return { items: [] };
  };
  const base = { key: 'b|512', fingerprint: 'absent', fileStat: stat(1, 4), now: 5, loadText: text('same'), produce };
  const reads = Promise.all([cache.read(base), cache.read(base)]);
  release();
  const [left, right] = await reads;
  assert.equal(produced, 1);
  assert.equal(left.value, right.value);
  assert.equal(right.hit, true);
});

for (const field of ['ctimeMs', 'ino', 'dev']) {
  test(`a changed ${field} invalidates a settled same-size same-mtime transcript`, async () => {
    const cache = createStoredTranscriptCache();
    const base = { key: 'identity', fingerprint: 'absent', fileStat: stat(1_000, 3), now: 10_000 };
    const produce = (body) => ({ body });
    await cache.read({ ...base, loadText: text('old'), produce });
    const changed = await cache.read({
      ...base,
      fileStat: { ...base.fileStat, [field]: base.fileStat[field] + 1 },
      loadText: text('new'),
      produce,
    });
    assert.equal(changed.read, true);
    assert.equal(changed.value.body, 'new');
  });
}

test('a recent ctime or incomplete identity cannot use the stat-only fast path', async () => {
  for (const fileStat of [
    { ...stat(1_000, 3), ctimeMs: 9_000 },
    { mtimeMs: 1_000, size: 3 },
  ]) {
    const cache = createStoredTranscriptCache();
    const base = { key: 'identity', fingerprint: 'absent', fileStat, now: 10_000 };
    const produce = (body) => ({ body });
    await cache.read({ ...base, loadText: text('old'), produce });
    const changed = await cache.read({ ...base, loadText: text('new'), produce });
    assert.equal(changed.read, true);
    assert.equal(changed.value.body, 'new');
  }
});

test('the cache stays within its entry and projected-byte budgets', async () => {
  // {"items":[]} is 12 serialized bytes; the source text size is irrelevant.
  const cache = createStoredTranscriptCache({ maxEntries: 2, maxBytes: 30 });
  const produce = () => ({ items: [] });
  const base = { fingerprint: '', fileStat: stat(1, 4), now: 5, produce };
  await cache.read({ ...base, key: '1', loadText: text('a'.repeat(1_000)) });
  await cache.read({ ...base, key: '2', loadText: text('bbbb') });
  await cache.read({ ...base, key: '3', loadText: text('cccc') });
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().retainedBytes, 24);
  const oversized = () =>
    cache.read({ ...base, key: '4', loadText: text('small'), produce: () => ({ items: ['x'.repeat(40)] }) });
  assert.equal((await oversized()).hit, false);
  assert.equal((await oversized()).hit, false, 'a projection larger than the whole budget is never retained');
});

test('unchanged session rotations do not churn at the former eight-session boundary', async () => {
  const cache = createStoredTranscriptCache();
  let produced = 0;
  let loaded = 0;
  const read = (id) =>
    cache.read({
      key: `${id}|512`,
      fingerprint: 'absent',
      fileStat: stat(1, 4),
      now: 10_000,
      loadText: () => {
        loaded++;
        return 'body';
      },
      produce: () => {
        produced++;
        return { items: [id] };
      },
    });
  for (let id = 0; id < 32; id++) await read(id);
  for (let round = 0; round < 3; round++) {
    for (let id = 0; id < 32; id++) {
      const result = await read(id);
      assert.equal(result.hit, true);
      assert.deepEqual(result.value.items, [id]);
    }
  }
  assert.equal(produced, 32);
  assert.equal(loaded, 32);
});

test('the projected-byte budget evicts least recently used entries without a session-count limit', async () => {
  // {"items":["a"]} is 15 serialized bytes: two fit in 30, three do not.
  const cache = createStoredTranscriptCache({ maxBytes: 30 });
  const read = (key) =>
    cache.read({
      key,
      fingerprint: '',
      loadText: text('body'),
      produce: () => ({ items: [key] }),
    });
  await read('a');
  await read('b');
  assert.equal((await read('a')).hit, true, 'a read refreshes recency');
  await read('c');
  assert.equal(cache.stats().retainedBytes, 30);
  assert.equal((await read('a')).hit, true);
  assert.equal((await read('b')).hit, false, 'the least recently used entry was evicted');
});

test('a round-robin refresh larger than the budget keeps serving the entries it can hold', async () => {
  // {"items":["k"]} is 15 serialized bytes: two of three fit in 30.
  const cache = createStoredTranscriptCache({ maxBytes: 30 });
  let loads = 0;
  const read = (key, now) =>
    cache.read({
      key,
      fingerprint: '',
      fileStat: stat(1, 4),
      now,
      loadText: () => {
        loads += 1;
        return `body ${key}`;
      },
      produce: () => ({ items: [key] }),
    });
  // A 1 s refresh clock over three unchanged, settled files.
  let now = 10_000;
  const perCycle = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const before = loads;
    for (const key of ['a', 'b', 'c']) await read(key, now);
    perCycle.push(loads - before);
    now += 1_000;
  }
  assert.deepEqual(perCycle.slice(2), [1, 1, 1], 'two of three are served without reading (plain LRU read all three)');
  assert.ok(cache.stats().retainedBytes <= 30);
  // Once the held entries go idle, the waiting one is admitted.
  now += 10_000;
  assert.equal((await read('a', now)).read, true);
  const before = loads;
  assert.equal((await read('a', now + 1_000)).read, false);
  assert.equal(loads, before);
});

test('a growing history window replaces its smaller predecessor in the same group', async () => {
  const cache = createStoredTranscriptCache();
  const read = (key, group) =>
    cache.read({ key, group, fingerprint: '', loadText: text('body'), produce: () => ({ items: [key] }) });
  await read('s|32|items', 's|items');
  await read('s|96|items', 's|items');
  await read('s|160|items', 's|items');
  await read('s|512|messages', 's|messages');
  await read('t|32|items', 't|items');
  assert.equal(cache.stats().entries, 3);
  assert.equal((await read('s|160|items', 's|items')).hit, true);
  assert.equal((await read('s|512|messages', 's|messages')).hit, true);
  assert.equal((await read('s|32|items', 's|items')).hit, false);
  cache.forget('s|');
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().retainedBytes, Buffer.byteLength(JSON.stringify({ items: ['t|32|items'] })));
});

test('a stored transcript read is served from cache until the record changes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-cache-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    mkdirSync(join(dataDir, 'sessions'));
    const id = `sess_cache_${process.pid}_${Date.now()}`;
    const write = (messages) =>
      writeFileSync(
        join(dataDir, 'sessions', `${id}.json`),
        JSON.stringify({ id, closed: true, generation: 1, messages })
      );
    write([{ role: 'user', content: 'first' }]);
    const { readStoredSessionTranscript, clearStoredTranscriptCache } = await import('./store-summary-reader.mjs');
    clearStoredTranscriptCache();
    const traces = [];
    const trace = (entry) => traces.push(entry);
    const first = await readStoredSessionTranscript(id, { transcriptItemLimit: 512, trace });
    const second = await readStoredSessionTranscript(id, { transcriptItemLimit: 512, trace });
    assert.equal(second, first);
    assert.match(String(first.projectionStamp), /^\d+:[a-z0-9]+:\d+$/);
    assert.deepEqual(
      traces.map((entry) => entry.hit),
      [false, true]
    );
    write([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
    const third = await readStoredSessionTranscript(id, { transcriptItemLimit: 512, trace });
    assert.notEqual(third, first);
    assert.notEqual(third.projectionStamp, first.projectionStamp);
    assert.equal(third.items.length, 2);
    assert.equal(traces.at(-1).hit, false);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('stored paging windows report older history, replace each other and are forgotten per session', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-window-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  const { readStoredSessionTranscript, clearStoredTranscriptCache, forgetStoredSessionTranscript, storedTranscriptCacheStats } =
    await import('./store-summary-reader.mjs');
  t.after(() => {
    clearStoredTranscriptCache();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  clearStoredTranscriptCache();
  mkdirSync(join(dataDir, 'sessions'));
  const id = `sess_window_${process.pid}`;
  const messages = Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: `prompt ${index}` }));
  writeFileSync(join(dataDir, 'sessions', `${id}.json`), JSON.stringify({ id, closed: true, generation: 1, messages }));

  const tail = await readStoredSessionTranscript(id, { transcriptItemLimit: 10 });
  assert.deepEqual(
    tail.items.map((item) => item.text),
    Array.from({ length: 10 }, (_, index) => `prompt ${40 + index}`)
  );
  assert.equal(tail.transcriptHasOlder, true);
  const page = await readStoredSessionTranscript(id, { transcriptItemLimit: 30 });
  assert.equal(page.items.length, 30);
  assert.deepEqual(page.items.slice(-10), tail.items, 'restore ids and rows are stable across windows');
  const whole = await readStoredSessionTranscript(id, { transcriptItemLimit: 64 });
  assert.equal(whole.items.length, 50);
  assert.equal(whole.transcriptHasOlder, false);
  assert.equal(storedTranscriptCacheStats().entries, 1, 'growing windows of one session do not accumulate');
  assert.equal(storedTranscriptCacheStats().retainedBytes, Buffer.byteLength(JSON.stringify(whole)));
  forgetStoredSessionTranscript(id);
  assert.deepEqual(storedTranscriptCacheStats(), { entries: 0, retainedBytes: 0, inFlight: 0 });
});

test('projection stamps are unique within a process', () => {
  assert.notEqual(nextProjectionStamp(), nextProjectionStamp());
});

test('the stored transcript reader notices a same-size rewrite with restored mtime', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-version-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  const { readStoredSessionTranscript, clearStoredTranscriptCache } = await import('./store-summary-reader.mjs');
  t.after(() => {
    clearStoredTranscriptCache();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  mkdirSync(join(dataDir, 'sessions'));
  const id = `sess_preserved_mtime_${process.pid}`;
  const file = join(dataDir, 'sessions', `${id}.json`);
  const time = new Date('2025-01-01T00:00:00.000Z');
  const write = (content) => {
    writeFileSync(file, JSON.stringify({ id, closed: true, generation: 1, messages: [{ role: 'user', content }] }));
    utimesSync(file, time, time);
  };
  write('old');
  const before = statSync(file);
  const first = await readStoredSessionTranscript(id, { includeMessages: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  write('new');
  const after = statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  const second = await readStoredSessionTranscript(id, { includeMessages: true });
  assert.notEqual(second.projectionStamp, first.projectionStamp);
  assert.equal(second.messages[0].content, 'new');
});

test('clear and forget fence pending projections without cancelling their readers', async () => {
  for (const invalidate of [(cache) => cache.clear(), (cache) => cache.forget('s|')]) {
    const cache = createStoredTranscriptCache();
    let release;
    const pending = cache.read({
      key: 's|512',
      fingerprint: '',
      loadText: text('old'),
      produce: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    invalidate(cache);
    release({ items: ['old'] });
    assert.deepEqual((await pending).value.items, ['old']);
    assert.equal(cache.stats().entries, 0);
    assert.equal(cache.stats().inFlight, 0);
  }
});

test('old projections cannot replace a newer completed projection', async () => {
  const cache = createStoredTranscriptCache();
  let release;
  const old = cache.read({
    key: 's',
    fingerprint: '',
    loadText: text('old'),
    produce: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const current = await cache.read({
    key: 's',
    fingerprint: '',
    loadText: text('new'),
    produce: () => ({ items: ['new'] }),
  });
  release({ items: ['old'] });
  await old;
  const again = await cache.read({
    key: 's',
    fingerprint: '',
    loadText: text('new'),
    produce: () => {
      throw new Error('new projection was lost');
    },
  });
  assert.equal(again.value, current.value);
});
