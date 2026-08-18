import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
