import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-large-cache-policy-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { rawContentCacheGet, rawContentCacheSet, runRawContentInFlight, invalidateBuiltinResultCache } = await import(
  './cache-layers.mjs'
);
const { readSourceWindows } = await import('./read-source-windows.mjs');
const { canCacheReadFile } = await import('./read-cache-policy.mjs');
test.after(async () => {
  invalidateBuiltinResultCache();
  await fs.rm(root, { recursive: true, force: true });
});

test('raw-content admission retains the exact 64KiB boundary but excludes larger files', async () => {
  for (const size of [65535, 65536, 65537]) {
    const path = join(root, `boundary-${size}.txt`);
    const bytes = Buffer.alloc(size, 120);
    await fs.writeFile(path, bytes);
    const st = await fs.stat(path);
    rawContentCacheSet(path, st, bytes);
    assert.equal(canCacheReadFile(st), size <= 65536);
    assert.equal(rawContentCacheGet(path, st), size <= 65536 ? bytes : null);
  }
  for (const size of [undefined, NaN, Infinity, -1]) assert.equal(canCacheReadFile({ size }), false);
});

test('large raw reads do not join an older same-version in-flight body', async () => {
  const path = join(root, 'raw.txt');
  const before = Buffer.from(`${'x'.repeat(65536)}BEFORE\n`);
  const after = Buffer.from(`${'x'.repeat(65536)}AFTER_\n`);
  await fs.writeFile(path, before);
  const st = await fs.stat(path);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const old = runRawContentInFlight(
    path,
    async () => {
      calls++;
      const bytes = await fs.readFile(path);
      entered.resolve();
      await release.promise;
      return bytes;
    },
    st
  );
  try {
    await entered.promise;
    await fs.writeFile(path, after);
    const fresh = runRawContentInFlight(
      path,
      async () => {
        calls++;
        return fs.readFile(path);
      },
      st
    );
    // Releasing the old reader cannot make it eligible for the new call.
    release.resolve();
    assert.deepEqual(await fresh, after);
    assert.deepEqual(await old, before);
    assert.equal(calls, 2);
    rawContentCacheSet(path, st, before);
    assert.equal(rawContentCacheGet(path, st), null, 'late large publications remain uncacheable');
  } finally {
    release.resolve();
    await old;
  }
});

test('large source windows do not share an older scan and close both handles', async (t) => {
  const path = join(root, 'source.txt');
  const prefix = 'prefix\n'.repeat(10000);
  await fs.writeFile(path, `${prefix}BEFORE\n`);
  const realOpen = fs.open;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let opens = 0;
  let closes = 0;
  const mock = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await realOpen(file, ...args);
    if (file === path) {
      const first = ++opens === 1;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        if (first && args[3] >= 65536 && result.bytesRead) {
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      handle.close = async () => {
        try {
          return await close();
        } finally {
          closes++;
        }
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  const old = readSourceWindows(path, [{ start: 10001, end: 10001 }]);
  try {
    await entered.promise;
    await fs.writeFile(path, `${prefix}AFTER_\n`);
    const fresh = readSourceWindows(path, [{ start: 10001, end: 10001 }]);
    release.resolve();
    assert.deepEqual([...(await fresh)], [[10001, 'AFTER_']]);
    assert.deepEqual([...(await old)], [[10001, 'BEFORE']]);
    assert.equal(opens, 2);
    assert.equal(closes, 2);
  } finally {
    release.resolve();
    await old;
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
