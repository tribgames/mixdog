import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('batch-publication');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { renderedBatchReadRanges, runBatchReadSnapshotPublication } = await import('./read-tool/batch-publication.mjs');
const {
  canPublishReadCache,
  invalidateBuiltinResultCache,
  registerCacheInvalidationListener,
  runReadCachePublication,
} = await import('./cache-layers.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
test.afterEach(() => invalidateBuiltinResultCache());

const identity = { mtimeMs: 1, ctimeMs: 2, size: 28, ino: 3, dev: 4 };
const scope = 'batch-test';
const body = '1\tFIRST\n2\tGAP\n3\tLAST\n[lines 1-3 of 4]';
const union = { source: 'read', ranges: [{ startLine: 1, endLine: 3 }] };
const sliced = {
  source: 'read_batch_sliced',
  ranges: [
    { startLine: 1, endLine: 1 },
    { startLine: 3, endLine: 3 },
  ],
  replaceExisting: true,
};

function fixture(produce = null) {
  const saved = new Map();
  const contexts = [];
  const helpers = {
    resolveAgainstCwd: (path, cwd) => resolve(cwd, path),
    classifyResultKind: (value) => (String(value).startsWith('Error:') ? 'error' : 'text'),
    _recordReadSnapshot: (path, st, readScope, meta) => {
      if (!canPublishReadCache(path)) return;
      saved.set(path, { ...meta, ...st, scope: readScope });
      contexts.push(AsyncLocalStorage.bind(() => canPublishReadCache(path)));
    },
  };
  const child = async (_name, args, _cwd, options) =>
    runReadCachePublication(args.path, async () => {
      const publish = (st = identity, meta = union) => options._readSnapshotRecorder(args.path, st, scope, meta);
      if (produce) return produce({ args, publish, saved });
      publish();
      return body;
    });
  return { helpers, child, saved, contexts };
}

function correct(helpers, path) {
  helpers._recordReadSnapshot(path, undefined, scope, sliced);
}

test('batch publication recognizes streamed rows and preserves gaps without a total-line footer', async () => {
  for (const separator of ['\t', '│', '→']) {
    assert.deepEqual(
      renderedBatchReadRanges(`1${separator}FIRST\n3${separator}LAST\n... [range limit reached]`),
      sliced.ranges
    );
  }
  assert.deepEqual(renderedBatchReadRanges('binary preview'), []);
  const path = join(root, 'streamed.txt');
  const fx = fixture(({ publish }) => {
    publish();
    return '1→FIRST\n2→GAP\n3→LAST\n... [range limit reached; next offset: 3]';
  });
  await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
    await child('read', { path }, root);
    correct(helpers, path);
  });
  assert.deepEqual(fx.saved.get(path), { ...sliced, ...identity, scope });
});

test('batch publication retains a fresh rejecting child without renewing its stale parent', async () => {
  const path = join(root, 'fresh.txt');
  const fx = fixture(async ({ args, publish }) => {
    invalidateBuiltinResultCache([args.path]);
    return runReadCachePublication(args.path, async () => {
      publish();
      return body;
    });
  });
  await runReadCachePublication(path, async () => {
    const result = await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
      const out = await child('read', { path }, root);
      assert.equal(fx.saved.size, 0, 'the coalesced union is never published');
      correct(helpers, path);
      return out;
    });
    assert.equal(result, body);
    assert.equal(canPublishReadCache(path), false, 'the old parent stays invalid');
  });
  assert.deepEqual(fx.saved.get(path), { ...sliced, ...identity, scope });
});

test('batch publication fences a stale producer instead of giving it a new lease', async () => {
  const path = join(root, 'stale.txt');
  const fx = fixture(({ args, publish }) => {
    invalidateBuiltinResultCache([args.path]);
    publish();
    return body;
  });
  const result = await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
    const out = await child('read', { path }, root);
    correct(helpers, path);
    return out;
  });
  assert.equal(result, body, 'existing readers may still return their original observation');
  assert.equal(fx.saved.size, 0);
});

test('batch publication preserves a newer snapshot and still publishes an unaffected sibling', async () => {
  const path = join(root, 'invalidated.txt');
  const sibling = join(root, 'unaffected.txt');
  const fx = fixture();
  await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
    await Promise.all([path, sibling].map((p) => child('read', { path: p }, root)));
    correct(helpers, path);
    correct(helpers, sibling);
    await Promise.resolve(); // the final sliced-snapshot phase may await range hashes
    invalidateBuiltinResultCache([path]);
    fx.saved.set(path, { source: 'newer-read' });
  });
  assert.deepEqual(fx.saved.get(path), { source: 'newer-read' });
  assert.deepEqual(fx.saved.get(sibling), { ...sliced, ...identity, scope });
});

for (const change of ['generation', 'version']) {
  test(`batch publication does not combine ${change}-mismatched child windows`, async () => {
    const path = join(root, `mixed-${change}.txt`);
    let calls = 0;
    const fx = fixture(async ({ args, publish }) => {
      if (++calls === 1) publish();
      else if (change === 'generation') {
        invalidateBuiltinResultCache([args.path]);
        await runReadCachePublication(args.path, async () => publish());
      } else publish({ ...identity, ctimeMs: 3 });
      return body;
    });
    await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
      await child('read', { path }, root);
      await child('read', { path }, root);
      correct(helpers, path);
    });
    assert.equal(fx.saved.size, 0);
  });
}

test('batch publication owns the observed stat and never replaces it with a later stat', async () => {
  const path = join(root, 'owned.txt');
  const observed = { ...identity };
  const fx = fixture(({ publish }) => {
    publish(observed);
    observed.ctimeMs++;
    return body;
  });
  await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
    await child('read', { path }, root);
    correct(helpers, path);
  });
  assert.equal(fx.saved.get(path).ctimeMs, identity.ctimeMs);
});

test('batch publication preserves non-sliced binary evidence', async () => {
  const path = join(root, 'binary.dat');
  const meta = { source: 'read_binary_preview', ranges: [] };
  const fx = fixture(({ publish }) => {
    publish(identity, meta);
    return 'binary preview';
  });
  await runBatchReadSnapshotPublication(fx.child, fx.helpers, (child) => child('read', { path }, root));
  assert.deepEqual(fx.saved.get(path), { ...meta, ...identity, scope });
});

test('batch publication discards observations when the aggregate rejects delivery', async () => {
  const path = join(root, 'rejected.txt');
  const fx = fixture();
  const result = await runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
    await child('read', { path }, root);
    correct(helpers, path);
    return 'Error: batch read rejected (reject_partial:true)';
  });
  assert.match(result, /^Error:/);
  assert.equal(fx.saved.size, 0, 'the caller never received the staged body');
});

for (const outcome of ['success', 'throw', 'abort']) {
  test(`batch publication releases retained leases after ${outcome}`, async () => {
    const path = join(root, `cleanup-${outcome}.txt`);
    let lateCapture;
    const fx = fixture(({ publish }) => {
      lateCapture = publish;
      publish();
      return body;
    });
    const result = runBatchReadSnapshotPublication(fx.child, fx.helpers, async (child, helpers) => {
      await child('read', { path }, root);
      correct(helpers, path);
      if (outcome === 'throw') throw new Error('batch failed');
      if (outcome === 'abort') throw new DOMException('batch aborted', 'AbortError');
      return body;
    });
    if (outcome === 'success') await result;
    else await assert.rejects(result, outcome === 'throw' ? /batch failed/ : { name: 'AbortError' });
    const before = structuredClone([...fx.saved]);
    lateCapture();
    await Promise.resolve();
    assert.deepEqual([...fx.saved], before, 'a late child cannot publish after the batch closes');
    if (outcome !== 'success') assert.equal(fx.saved.size, 0);
    for (const isCurrent of fx.contexts) assert.equal(isCurrent(), false, 'the held lease was released');
    await runReadCachePublication(path, async () => assert.equal(canPublishReadCache(path), true));
  });
}

for (const mode of ['head', 'tail']) {
  test(`coalesced batch preserves inherited publication fencing for ${mode}`, async () => {
    const { executeReadTool } = await import('./read-tool.mjs');
    // A lone string path[] is intentionally normalized to a scalar. Keep
    // two real operands so this fixture reaches the batch publication fence.
    const paths = [0, 1].map((index) => join(root, `glance-${mode}-${index}.txt`));
    for (const path of paths) writeFileSync(path, 'BEFORE\n');
    const entries = paths.map((path) => ({ path, mode, n: 1 }));
    const fx = fixture();
    const called = new Set();
    const result = await executeReadTool(
      {
        path: paths,
        _readsEntries: entries,
        _readsOrigEntries: entries,
        _readsEntryToDeduped: [0, 1],
      },
      root,
      scope,
      async (name, args) => {
        const path = args.path;
        assert.equal(paths.includes(path), true);
        called.add(path);
        assert.equal(name, 'read');
        assert.equal(args.mode, mode);
        assert.equal(canPublishReadCache(path), true);
        invalidateBuiltinResultCache([path]);
        assert.equal(canPublishReadCache(path), false, 'glance children retain the original batch fence');
        fx.helpers._recordReadSnapshot(path, identity, scope, union);
        return 'BEFORE';
      },
      { _skipReachPreflight: true },
      {
        ...fx.helpers,
        normalizeInputPath: (value) => value,
        normalizeOutputPath: (value) => value,
        normaliseReadLineWindowArgs: (value) => value,
        READ_MAX_OUTPUT_BYTES: 16384,
        _isFullModeReadEntry: () => false,
        _mergeReadRanges: (ranges) => ranges,
      }
    );
    assert.equal(called.size, paths.length);
    assert.match(result, /BEFORE/);
    assert.equal(fx.saved.size, 0);
    for (const path of paths) assert.equal(canPublishReadCache(path), true, 'the batch lease is released');
  });
}

for (const encoding of ['utf8', 'utf16le']) {
  for (const shape of ['path', 'file_path']) {
    test(`coalesced hash rejection records only delivered windows (${encoding}, ${shape})`, async (t) => {
      const { executeBuiltinTool } = await import('../builtin.mjs');
      const { getReadSnapshot } = await import('./read-snapshot-runtime.mjs');
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      const encode = (text) =>
        encoding === 'utf8'
          ? Buffer.from(text)
          : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
      const path = join(root, `${randomUUID()}.txt`);
      writeFileSync(path, encode('BEFORE\nGAP___\nLAST_A\nTAIL__\n'));
      const time = new Date('2025-01-01T00:00:00.000Z');
      utimesSync(path, time, time);
      const before = statSync(path);
      const originalStat = fsPromises.stat;
      const mock = t.mock.method(fsPromises, 'stat', async (target, ...options) => {
        const st = await originalStat(target, ...options);
        if (target === path) st.ctimeMs = before.ctimeMs;
        return st;
      });
      // Streaming owns a descriptor version and rechecks it against the path.
      // Both observations must collide for this fixture's intended race.
      const originalOpen = fsPromises.open;
      const openMock = t.mock.method(fsPromises, 'open', async (target, ...options) => {
        const handle = await originalOpen(target, ...options);
        if (target === path) {
          const stat = handle.stat.bind(handle);
          handle.stat = async (...options) => {
            const st = await stat(...options);
            st.ctimeMs = before.ctimeMs;
            return st;
          };
        }
        return handle;
      });
      syncBuiltinESMExports();
      let unsubscribe;
      try {
        const args =
          shape === 'path'
            ? {
                path: [
                  { path, offset: 0, limit: 1 },
                  { path, offset: 2, limit: 1 },
                ],
              }
            : {
                file_path: [
                  { file_path: path, offset: 1, limit: 1 },
                  { file_path: path, offset: 3, limit: 1 },
                ],
              };
        const options = { sessionId: randomUUID(), suppressReadUnchangedStub: true };
        const first = String(await executeBuiltinTool('read', args, root, options));
        assert.match(first, /BEFORE/);
        assert.match(first, /LAST_A/);
        assert.doesNotMatch(first, /GAP___/);
        let invalidations = 0;
        unsubscribe = registerCacheInvalidationListener(() => invalidations++);
        writeFileSync(path, encode('AFTER_\nGAP___\nLAST_B\nTAIL__\n'));
        utimesSync(path, time, time);
        const observed = await fsPromises.stat(path);
        const handle = await fsPromises.open(path, 'r');
        let descriptor;
        try {
          descriptor = await handle.stat();
        } finally {
          await handle.close();
        }
        for (const key of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) {
          assert.equal(observed[key], before[key], `${key} must collide`);
          assert.equal(descriptor[key], before[key], `descriptor ${key} must collide`);
        }
        const second = String(await executeBuiltinTool('read', args, root, options));
        assert.match(second, /AFTER_/);
        assert.match(second, /LAST_B/);
        assert.doesNotMatch(second, /GAP___/);
        assert.equal(invalidations, 1, 'the child must actually reject its cached hash');
        const snapshot = getReadSnapshot(path, options.sessionId);
        assert.equal(snapshot.source, 'read_batch_sliced');
        assert.deepEqual(snapshot.ranges, sliced.ranges);
        assert.deepEqual(snapshot.rangeHashes, [
          { startLine: 1, endLine: 1, hash: hash('AFTER_') },
          { startLine: 3, endLine: 3, hash: hash('LAST_B') },
        ]);
        assert.equal(snapshot.contentHash, undefined);
        assert.equal(snapshot.fileLineCount, undefined);
        assert.notEqual(snapshot.bodyDelivered, true);
        assert.equal(String(await executeBuiltinTool('read', args, root, options)), second);
        assert.equal(invalidations, 1, 'unchanged bytes keep their normal cache hit');
      } finally {
        unsubscribe?.();
        mock.mock.restore();
        openMock.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
}
