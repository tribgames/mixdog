import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-read-publication-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const {
  cacheGet,
  cacheGetEntry,
  cacheSet,
  rawContentCacheGet,
  rawContentCacheSet,
  invalidateBuiltinResultCache,
  runRawContentInFlight,
  runReadCachePublication,
  canPublishReadCache,
} = await import('./cache-layers.mjs');
const { recordReadSnapshot, getReadSnapshot } = await import('./read-snapshot-runtime.mjs');
const { readCachedResult } = await import('./read-single-fast-paths.mjs');
const { streamRangeResult } = await import('./read-single-stream.mjs');
const { executeBuiltinTool } = await import('../builtin.mjs');
const { recordSlicedBatchSnapshots } = await import('./read-tool/batch-snapshot.mjs');
const { mergeReadRanges } = await import('./read-ranges.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
test.afterEach(() => invalidateBuiltinResultCache());

const oldBody = Buffer.from('before');
const newBody = Buffer.from('fresh!');
const version = { mtimeMs: 1, ctimeMs: 2, size: oldBody.length, ino: 3, dev: 4 };
const hash = (value) => createHash('sha256').update(value).digest('hex');

for (const invalidation of ['file', 'directory', 'global']) {
  test(`${invalidation} invalidation fences old publications but admits a new generation`, async () => {
    const path = join(root, 'scope', 'file.txt');
    const sibling = join(root, 'scope-other', 'file.txt');
    const done = Promise.withResolvers();
    const old = runReadCachePublication(path, async () => {
      await done.promise;
      assert.equal(canPublishReadCache(), false);
      cacheSet('target', 'old', { paths: [path] });
      rawContentCacheSet(path, version, oldBody);
      return oldBody;
    });
    const other = runReadCachePublication(sibling, async () => {
      await done.promise;
      assert.equal(canPublishReadCache(), invalidation !== 'global');
      cacheSet('sibling', 'unchanged', { paths: [sibling] });
      rawContentCacheSet(sibling, version, oldBody);
    });
    try {
      if (invalidation === 'global') invalidateBuiltinResultCache();
      else {
        const affected = invalidation === 'directory' ? dirname(path) : path;
        invalidateBuiltinResultCache([process.platform === 'win32' ? affected.toUpperCase() : affected]);
      }
      await runReadCachePublication(path, async () => {
        assert.equal(canPublishReadCache(), true);
        cacheSet('target', 'new', { paths: [path] });
        rawContentCacheSet(path, version, newBody);
      });
      done.resolve();
      assert.equal(await old, oldBody, 'invalidation does not cancel existing readers');
      await other;
      assert.equal(cacheGet('target'), 'new');
      assert.equal(rawContentCacheGet(path, version), newBody);
      assert.equal(cacheGet('sibling'), invalidation === 'global' ? null : 'unchanged');
      assert.equal(rawContentCacheGet(sibling, version), invalidation === 'global' ? null : oldBody);
    } finally {
      done.resolve();
      await Promise.allSettled([old, other]);
    }
  });
}

test('current concurrent read leases still share the same raw IO and publish', async () => {
  const path = join(root, 'shared.txt');
  const done = Promise.withResolvers();
  let loads = 0;
  const loader = () => {
    loads++;
    return done.promise;
  };
  const reads = Array.from({ length: 8 }, () =>
    runReadCachePublication(path, async () => {
      const bytes = await runRawContentInFlight(path, loader, version);
      assert.equal(canPublishReadCache(), true);
      rawContentCacheSet(path, version, bytes);
      return bytes;
    })
  );
  done.resolve(newBody);
  assert.deepEqual(await Promise.all(reads), Array(8).fill(newBody));
  assert.equal(loads, 1);
  assert.equal(rawContentCacheGet(path, version), newBody);
});

for (const outcome of ['return', 'throw', 'abort']) {
  test(`a ${outcome} releases publication rights, including detached descendants`, async () => {
    for (let i = 0; i < 16; i++) {
      const path = join(root, `${outcome}-${i}.txt`);
      const done = Promise.withResolvers();
      let descendant;
      const reading = runReadCachePublication([path, path, `${path}-sibling`], async () => {
        descendant = done.promise.then(() => {
          assert.equal(canPublishReadCache(), false);
          cacheSet('late', 'old', { paths: [path] });
          rawContentCacheSet(path, version, oldBody);
        });
        if (outcome === 'throw') throw new Error('read failed');
        if (outcome === 'abort') {
          const controller = new AbortController();
          controller.abort();
          controller.signal.throwIfAborted();
        }
        return 'early return';
      });
      try {
        if (outcome === 'return') assert.equal(await reading, 'early return');
        else await assert.rejects(reading, outcome === 'throw' ? /read failed/ : { name: 'AbortError' });
        done.resolve();
        await descendant;
        assert.equal(cacheGet('late'), null);
        assert.equal(rawContentCacheGet(path, version), null);
        await runReadCachePublication(path, async () => {
          assert.equal(canPublishReadCache(), true, 'a later read has independent publication rights');
        });
        assert.equal(canPublishReadCache(), true, 'the caller is not left inside a released lease');
      } finally {
        done.resolve();
        await Promise.allSettled([reading, descendant]);
      }
    }
  });
}

for (const kind of ['cache-hit', 'stream']) {
  test(`${kind} cannot publish a snapshot after its lease is invalidated`, async () => {
    const path = join(root, `${randomUUID()}.txt`);
    writeFileSync(path, oldBody);
    const st = statSync(path);
    const scope = randomUUID();
    const key = randomUUID();
    const ctx = { fullPath: path, filePath: path, st, cacheKey: key, readStateScope: scope };
    const helpers = {
      _cacheGetEntry: cacheGetEntry,
      _cacheSet: cacheSet,
      _recordReadSnapshot: recordReadSnapshot,
      classifyResultKind: () => 'text',
      normalizeOutputPath: (value) => value,
      _rangeHashesFromRenderedReadText: () => [],
    };
    let result;
    if (kind === 'cache-hit') {
      cacheSet(key, 'before', {
        paths: [path],
        contentPrefixHash: hash(oldBody),
        readSnapshotMeta: { source: 'read', ranges: [{ startLine: 1, endLine: 1 }] },
      });
      result = await runReadCachePublication(path, () =>
        readCachedResult(ctx, {
          ...helpers,
          _hashText: (bytes) => {
            invalidateBuiltinResultCache([path]);
            return hash(bytes);
          },
        })
      );
      assert.equal(result.result, 'before');
    } else {
      result = await runReadCachePublication(path, () =>
        streamRangeResult(
          ctx,
          { source: 'read_stream_range' },
          {
            ...helpers,
            streamReadRange: async () => {
              invalidateBuiltinResultCache([path]);
              return { text: 'before', firstEmitted: 1, lastEmitted: 1, prefixHash: hash(oldBody) };
            },
          }
        )
      );
      assert.equal(result, 'before');
    }
    assert.equal(cacheGet(key), null);
    assert.ok(!getReadSnapshot(path, scope), 'invalidated evidence must not authorize later edits');
  });
}

test('an invalidated batch cannot replace a newer snapshot but still records unaffected paths', async (t) => {
  const path = join(root, `${randomUUID()}.txt`);
  const sibling = join(root, `${randomUUID()}.txt`);
  const encode = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  writeFileSync(path, encode('BEFORE\nTAIL_A\nLAST_A\n'));
  writeFileSync(sibling, encode('FIRST\nSIBLING\nLAST\n'));
  const paused = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const originalRead = fsPromises.readFile;
  const originalStat = fsPromises.stat;
  let bodySeen = false;
  let held = false;
  const readMock = t.mock.method(fsPromises, 'readFile', async (target, ...args) => {
    const bytes = await originalRead(target, ...args);
    if (target === path) bodySeen = true;
    return bytes;
  });
  const statMock = t.mock.method(fsPromises, 'stat', async (target, ...args) => {
    const st = await originalStat(target, ...args);
    if (target === path && bodySeen && !held) {
      held = true;
      paused.resolve();
      await resume.promise;
    }
    return st;
  });
  syncBuiltinESMExports();
  let old;
  try {
    const options = { sessionId: randomUUID(), suppressReadUnchangedStub: true };
    old = executeBuiltinTool(
      'read',
      {
        file_path: [
          { file_path: path, offset: 1, limit: 1 },
          { file_path: sibling, offset: 2, limit: 1 },
        ],
      },
      root,
      options
    );
    await Promise.race([
      paused.promise,
      old.then(() => assert.fail('the batch child must pause after reading its old body')),
    ]);
    const replacement = encode('AFTER_\nTAIL_B\nLAST_B\n');
    writeFileSync(path, replacement);
    invalidateBuiltinResultCache([path]);
    const fresh = String(await executeBuiltinTool('read', { file_path: path }, root, options));
    assert.match(fresh, /AFTER_/);
    const freshSnapshot = structuredClone(getReadSnapshot(path, options.sessionId));
    assert.ok(freshSnapshot.contentHash);
    resume.resolve();
    assert.match(String(await old), /BEFORE/, 'the old batch retains its original result');
    assert.deepEqual(getReadSnapshot(path, options.sessionId), freshSnapshot);
    assert.deepEqual(rawContentCacheGet(path, statSync(path)), replacement);
    const siblingSnapshot = getReadSnapshot(sibling, options.sessionId);
    assert.equal(siblingSnapshot.source, 'read_batch_sliced');
    assert.deepEqual(siblingSnapshot.ranges, [{ startLine: 2, endLine: 2 }]);
    assert.equal(siblingSnapshot.rangeHashes[0].hash, hash('SIBLING'));
  } finally {
    resume.resolve();
    await Promise.allSettled([old]);
    readMock.mock.restore();
    statMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('multi-path leases preserve sibling publication without renewing an invalidated parent', async () => {
  const path = join(root, 'multi', 'file.txt');
  const sibling = join(root, 'multi-other', 'file.txt');
  await runReadCachePublication([path, path, sibling], async () => {
    invalidateBuiltinResultCache([path]);
    assert.equal(canPublishReadCache(path), false);
    assert.equal(canPublishReadCache(sibling), true);
    assert.equal(canPublishReadCache([path, sibling]), false);
    assert.equal(canPublishReadCache(root), false);
    assert.equal(canPublishReadCache(), false);
    assert.equal(canPublishReadCache([]), false);
    cacheSet('mixed', 'stale', { paths: [path, sibling] });
    cacheSet('scoped', 'stale', { scopes: [root] });
    cacheSet('unknown', 'stale');
    cacheSet('sibling', 'good', { paths: [sibling] });
    rawContentCacheSet(sibling, version, newBody);
    await runReadCachePublication(path, async () => {
      assert.equal(canPublishReadCache(path), true);
      cacheSet('fresh', 'good', { paths: [path] });
      rawContentCacheSet(path, version, newBody);
    });
    assert.equal(canPublishReadCache(path), false, 'a fresh child does not renew the parent');
    rawContentCacheSet(path, version, oldBody);
  });
  assert.equal(cacheGet('mixed'), null);
  assert.equal(cacheGet('scoped'), null);
  assert.equal(cacheGet('unknown'), null);
  assert.equal(cacheGet('fresh'), 'good');
  assert.equal(cacheGet('sibling'), 'good');
  assert.equal(rawContentCacheGet(path, version), newBody);
  assert.equal(rawContentCacheGet(sibling, version), newBody);
});

test('batch snapshot publication rechecks its lease after awaiting fallback range hashes', async (t) => {
  const path = join(root, `${randomUUID()}.txt`);
  const sibling = join(root, `${randomUUID()}.txt`);
  writeFileSync(path, 'AFTER_\n');
  writeFileSync(sibling, 'SIBLING\n');
  const scope = randomUUID();
  await executeBuiltinTool('read', { file_path: path }, root, { sessionId: scope });
  const freshSnapshot = structuredClone(getReadSnapshot(path, scope));
  const originalRead = fsPromises.readFile;
  let invalidations = 0;
  const mock = t.mock.method(fsPromises, 'readFile', async (target, ...args) => {
    const bytes = await originalRead(target, ...args);
    if (target === path) {
      invalidateBuiltinResultCache([path]);
      invalidations++;
    }
    return bytes;
  });
  syncBuiltinESMExports();
  try {
    await runReadCachePublication([path, sibling], () =>
      recordSlicedBatchSnapshots(
        [
          { path, mode: 'full', body: '[lines 1-1]\nBEFORE\n[lines 1-1 of 1]' },
          { path: sibling, mode: 'full', body: '[lines 1-1]\nSIBLING\n[lines 1-1 of 1]' },
        ],
        root,
        scope,
        {
          classifyResultKind: () => 'text',
          resolveAgainstCwd: (value) => value,
          _rangeHashesFromRenderedReadText: () => [],
          _mergeReadRanges: mergeReadRanges,
          _recordReadSnapshot: recordReadSnapshot,
          _hashText: hash,
        }
      )
    );
    assert.equal(invalidations, 1);
    assert.deepEqual(getReadSnapshot(path, scope), freshSnapshot);
    assert.equal(getReadSnapshot(sibling, scope).source, 'read_batch_sliced');
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
