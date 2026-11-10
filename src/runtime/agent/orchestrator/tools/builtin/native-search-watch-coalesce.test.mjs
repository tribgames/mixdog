import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

// Invalidation unlinks persisted read indexes; keep them out of the user's data.
const base = mkdtempSync(join(tmpdir(), 'mixdog-watch-coalesce-'));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

const { cacheGet, cacheSet, invalidateBuiltinResultCache, registerCacheInvalidationListener, statCacheSet } =
  await import('./cache-layers.mjs');
const { canonicalCachePath } = await import('./read-range-index.mjs');
const { _onNativeSearchLineForTest: onLine, flushNativeWatcherInvalidations } = await import(
  './native-search-client.mjs'
);

// Paths need not exist: a watcher reports deletions too.
const root = join(base, 'watched');
const other = join(base, 'unrelated');

test.afterEach(() => {
  flushNativeWatcherInvalidations();
  invalidateBuiltinResultCache();
});

const fakeServer = () => ({ pending: new Map(), cancelWatchdogs: new Map(), resolveReady() {} });
const invalidate = (server, paths) => onLine(server, JSON.stringify({ event: 'invalidate', paths }));

function listen(t) {
  const calls = [];
  t.after(registerCacheInvalidationListener((paths, source) => calls.push({ paths, source })));
  return calls;
}

function countSyncFsCalls(t) {
  const counts = {};
  for (const name of ['existsSync', 'lstatSync', 'statSync', 'realpathSync', 'readdirSync', 'accessSync']) {
    counts[name] = 0;
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      counts[name] += 1;
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return counts;
}

test('a 10,000-path watcher burst is applied in one flush with no sync fs call', (t) => {
  const server = fakeServer();
  const touched = join(root, 'src');
  cacheSet('under', 'v', { paths: [join(touched, 'd7', 'f7.txt')] });
  cacheSet('scope', 'v', { scopes: [root] });
  cacheSet('unrelated', 'v', { paths: [join(other, 'x.txt')], scopes: [other] });
  const calls = listen(t);
  const counts = countSyncFsCalls(t);
  const startedAt = performance.now();
  for (let line = 0; line < 20; line += 1) {
    const paths = Array.from({ length: 500 }, (_, i) => {
      const n = line * 500 + i;
      return join(touched, `d${n % 100}`, `f${n}.txt`);
    });
    invalidate(server, paths);
  }
  assert.equal(calls.length, 0, 'no invalidation runs before the window closes');
  // A server response is a sync point: the pending batch lands before it.
  let seenAtResponse = -1;
  server.pending.set(1, { resolve: () => (seenAtResponse = calls.length) });
  onLine(server, JSON.stringify({ id: 1, lines: [] }));
  const elapsedMs = performance.now() - startedAt;
  assert.equal(seenAtResponse, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source.canonical, true);
  assert.ok(calls[0].paths.length <= 512, `${calls[0].paths.length} paths`);
  assert.equal(cacheGet('under'), null);
  assert.equal(cacheGet('scope'), null);
  assert.equal(cacheGet('unrelated'), 'v');
  assert.deepEqual(Object.values(counts), Object.values(counts).fill(0), JSON.stringify(counts));
  assert.ok(elapsedMs < 1_000, `${elapsedMs}ms`);
});

test('an over-cap watcher batch collapses to its root on the window timer', async (t) => {
  const server = fakeServer();
  cacheSet('inside', 'v', { paths: [join(root, 'kept-dir', 'a.txt')] });
  cacheSet('unrelated', 'v', { paths: [join(other, 'x.txt')] });
  const calls = listen(t);
  invalidate(
    server,
    Array.from({ length: 600 }, (_, i) => join(root, `d${i}`, 'f.txt'))
  );
  assert.equal(calls.length, 0);
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].paths, [canonicalCachePath(root)]);
  // Covered by the root even though no reported path named it.
  assert.equal(cacheGet('inside'), null);
  assert.equal(cacheGet('unrelated'), 'v');
});

test('a tool invalidation stays immediate while a watcher batch is pending', (t) => {
  const server = fakeServer();
  const written = join(root, 'tool.txt');
  const watched = join(root, 'watched.txt');
  cacheSet('tool', 'v', { paths: [written] });
  cacheSet('watched', 'v', { paths: [watched] });
  const calls = listen(t);
  invalidate(server, [watched]);
  invalidateBuiltinResultCache([written]);
  assert.equal(cacheGet('tool'), null);
  assert.deepEqual(
    calls.map((call) => call.source?.canonical === true),
    [false]
  );
  assert.equal(cacheGet('watched'), 'v');
  flushNativeWatcherInvalidations();
  assert.equal(cacheGet('watched'), null);
  assert.deepEqual(
    calls.map((call) => call.source?.canonical === true),
    [false, true]
  );
});

test('a 10,000-path invalidation over full caches costs paths plus entries, not their product', () => {
  for (let i = 0; i < 1_000; i += 1) statCacheSet(join(other, `s${i}.txt`), { size: i });
  for (let i = 0; i < 199; i += 1) {
    cacheSet(`r${i}`, 'v', { paths: [join(other, `r${i}.txt`)], scopes: [join(other, `scope${i}`)] });
  }
  cacheSet('hit', 'v', { scopes: [join(root, 'pkg')] });
  const paths = Array.from({ length: 10_000 }, (_, i) => join(root, 'pkg', `d${i % 100}`, `f${i}.txt`));
  const startedAt = performance.now();
  invalidateBuiltinResultCache(paths);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(cacheGet('hit'), null);
  assert.equal(cacheGet('r0'), 'v');
  assert.equal(cacheGet('r198'), 'v');
  // ~0.3 s here; matching every entry against every path took ~12 s.
  assert.ok(elapsedMs < 3_000, `${elapsedMs}ms`);
});
