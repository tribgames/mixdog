import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEXT_CACHE_MAX_BYTES } from './text-cache-budget.mjs';

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
