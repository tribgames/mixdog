import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { READ_PREFIX_HASH_BYTES } from '../../tools/builtin/read-cache-policy.mjs';
import { TEXT_CACHE_MAX_BYTES } from './text-cache-budget.mjs';
import { _normalizeCacheKey, _statEqual, _statTuple } from './util.mjs';

test('prefetch disk cache uses a full hash and rejects a mismatched path identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-cache-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const source = join(root, 'source.txt');
  writeFileSync(source, 'source');
  try {
    const first = await import(`./prefetch-cache.mjs?writer=${Date.now()}`);
    first.setPrefetchCached(source, 'cached output');
    first.drainPrefetchDiskWrites();
    const cacheDir = join(root, 'cache', 'prefetch');
    const [cacheFile] = readdirSync(cacheDir);
    assert.match(cacheFile, /^[0-9a-f]{64}\.json$/);

    const path = join(cacheDir, cacheFile);
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ ...payload, absPath: `${source}.other` }));

    const second = await import(`./prefetch-cache.mjs?reader=${Date.now()}`);
    assert.equal(second.tryPrefetchCached(source), null);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('deferred prefetch insertion rejects changed or unavailable source versions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-version-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const cache = await import(`./prefetch-cache.mjs?version=${root}`);
  t.after(() => {
    cache.drainPrefetchDiskWrites();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, 'source.txt');
  writeFileSync(source, 'before');
  const before = cache.capturePrefetchCacheState(source);
  writeFileSync(source, 'after modification');
  cache.setPrefetchCached(source, 'before', before);
  assert.equal(cache.tryPrefetchCached(source), null);
  cache.setPrefetchCached(source, 'unversioned', null);
  assert.equal(cache.tryPrefetchCached(source), null);
  cache.setPrefetchCached(source, 'current', cache.capturePrefetchCacheState(source));
  assert.equal(cache.tryPrefetchCached(source)?.content, 'current');
  cache.setPrefetchCached(source, 'x'.repeat(TEXT_CACHE_MAX_BYTES / 2));
  assert.equal(cache.tryPrefetchCached(source), null);
});

test('disk hydration enforces the same prefetch entry bound as fresh insertion', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-hydration-'));
  const previousDir = process.env.MIXDOG_DATA_DIR;
  const previousCap = process.env.MIXDOG_PREFETCH_CACHE_MAX;
  process.env.MIXDOG_DATA_DIR = root;
  process.env.MIXDOG_PREFETCH_CACHE_MAX = '1';
  const modules = [];
  t.after(() => {
    for (const cache of modules) cache.drainPrefetchDiskWrites();
    if (previousDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDir;
    if (previousCap === undefined) delete process.env.MIXDOG_PREFETCH_CACHE_MAX;
    else process.env.MIXDOG_PREFETCH_CACHE_MAX = previousCap;
    rmSync(root, { recursive: true, force: true });
  });
  const sources = ['first', 'second'].map((name) => join(root, `${name}.txt`));
  // Separate writers model the shared disk cache left by different workers.
  for (const [index, source] of sources.entries()) {
    writeFileSync(source, `source-${index}`);
    const writer = await import(`./prefetch-cache.mjs?writer=${root}-${index}`);
    modules.push(writer);
    writer.setPrefetchCached(source, `result-${index}`);
    writer.drainPrefetchDiskWrites();
  }
  const reader = await import(`./prefetch-cache.mjs?reader=${root}`);
  modules.push(reader);
  assert.equal(reader.tryPrefetchCached(sources[0])?.content, 'result-0');
  assert.equal(reader.tryPrefetchCached(sources[1])?.content, 'result-1');
  assert.equal(reader.tryPrefetchCached(sources[0]), null);
  assert.equal(reader.tryPrefetchCached(sources[1])?.content, 'result-1');
});

const FIXED_TIME = new Date('2025-01-01T00:00:00.000Z');
const PREFIX_LINE = `${'A'.repeat(63)}\n`;
const SUFFIX_LINE = READ_PREFIX_HASH_BYTES / PREFIX_LINE.length + 1;

function largeLines(suffix) {
  return `${PREFIX_LINE.repeat(SUFFIX_LINE - 1)}${suffix}\n`;
}
function prefetchDiskPath(root, absPath) {
  const key = _normalizeCacheKey(absPath);
  return {
    key,
    path: join(root, 'cache', 'prefetch', `${createHash('sha256').update(key).digest('hex')}.json`),
  };
}
function pinCtime(t, file, ctimeMs) {
  const key = _normalizeCacheKey(file);
  const original = fs.statSync;
  const mock = t.mock.method(fs, 'statSync', (path, ...options) => {
    const st = original(path, ...options);
    if (_normalizeCacheKey(path) === key) st.ctimeMs = ctimeMs;
    return st;
  });
  syncBuiltinESMExports();
  return () => {
    mock.mock.restore();
    syncBuiltinESMExports();
  };
}

test('prefix-budget files stay prefetchable and larger files do not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-budget-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const cache = await import(`./prefetch-cache.mjs?budget=${root}`);
  const modules = [cache];
  t.after(() => {
    for (const loaded of modules) loaded.drainPrefetchDiskWrites();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const exact = join(root, 'exact.txt');
  const over = join(root, 'over.txt');
  writeFileSync(exact, 'e'.repeat(READ_PREFIX_HASH_BYTES));
  writeFileSync(over, 'o'.repeat(READ_PREFIX_HASH_BYTES + 1));
  assert.equal(statSync(exact).size, READ_PREFIX_HASH_BYTES);
  assert.equal(statSync(over).size, READ_PREFIX_HASH_BYTES + 1);
  const exactState = cache.capturePrefetchCacheState(exact);
  assert.equal(exactState?.size, READ_PREFIX_HASH_BYTES);
  cache.setPrefetchCached(exact, 'exact-body', exactState);
  assert.equal(cache.tryPrefetchCached(exact)?.content, 'exact-body');
  cache.drainPrefetchDiskWrites();
  assert.equal(cache.capturePrefetchCacheState(over), null);
  cache.setPrefetchCached(over, 'over-body', _statTuple(over));
  cache.setPrefetchCached(over, 'over-body');
  cache.setPrefetchCached(over, 'over-body', null);
  cache.drainPrefetchDiskWrites();
  assert.equal(cache.tryPrefetchCached(over), null);
  assert.equal(existsSync(prefetchDiskPath(root, over).path), false);
  assert.equal(cache.tryPrefetchCached(exact)?.content, 'exact-body');
  const reader = await import(`./prefetch-cache.mjs?budget-reader=${root}`);
  modules.push(reader);
  assert.equal(reader.tryPrefetchCached(exact)?.content, 'exact-body');
  assert.equal(reader.tryPrefetchCached(over), null);
});

test('prefix-budget persisted prefetch rows ignore same-metadata suffix rewrites', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-legacy-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const source = join(root, 'large.txt');
  writeFileSync(source, largeLines('OLD_SUFFIX'));
  utimesSync(source, FIXED_TIME, FIXED_TIME);
  const stat = _statTuple(source);
  assert.ok(stat?.size > READ_PREFIX_HASH_BYTES);
  const disk = prefetchDiskPath(root, source);
  mkdirSync(join(root, 'cache', 'prefetch'), { recursive: true });
  writeFileSync(disk.path, JSON.stringify({ absPath: disk.key, content: 'STALE_OLD_SUFFIX', stat, ts: Date.now() }));
  writeFileSync(source, largeLines('NEW_SUFFIX'));
  utimesSync(source, FIXED_TIME, FIXED_TIME);
  const restore = pinCtime(t, source, stat.ctimeMs);
  let cache;
  t.after(() => {
    restore();
    cache?.drainPrefetchDiskWrites();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  cache = await import(`./prefetch-cache.mjs?legacy=${root}`);
  assert.equal(_statEqual(_statTuple(source), stat), true);
  assert.equal(cache.tryPrefetchCached(source), null);
  assert.equal(existsSync(disk.path), false);
  cache.setPrefetchCached(source, 'STALE_OLD_SUFFIX', stat);
  cache.drainPrefetchDiskWrites();
  assert.equal(existsSync(disk.path), false);
  assert.equal(cache.tryPrefetchCached(source), null);
});
