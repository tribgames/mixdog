import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _resolveBoundedSentinelFreeAggregateRootForTest } from './dispatch.mjs';
import { _retryCodeGraphBuildAfterInvalidation, _runDiskCodeGraphFastPath, _spawnCodeGraphWorker } from './build.mjs';

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.terminations = 0;
  }
  terminate() {
    this.terminations += 1;
    return Promise.resolve(0);
  }
}

test('successful code-graph build terminates its worker', async () => {
  let worker = null;
  const pending = _spawnCodeGraphWorker(process.cwd(), process.cwd(), 0, null, null, null, {
    createWorker() {
      worker = new FakeWorker();
      return worker;
    },
    getGeneration: () => 0,
    setMemoryCache: () => {},
    setDiskCache: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  worker.emit('message', { ok: true, graph: { files: [] }, signature: 'sig' });

  assert.deepEqual(await pending, { files: [] });
  assert.equal(worker.terminations, 1);
});

test('code-graph retries one stale worker result with the latest generation', async () => {
  const workers = [];
  let starts = 0;
  const graph = await _retryCodeGraphBuildAfterInvalidation(async () => {
    const attempt = starts++;
    return _spawnCodeGraphWorker(process.cwd(), process.cwd(), attempt, null, null, null, {
      createWorker() {
        const worker = new FakeWorker();
        workers.push(worker);
        queueMicrotask(() =>
          worker.emit('message', {
            ok: true,
            graph: { attempt },
            signature: `sig-${attempt}`,
          })
        );
        return worker;
      },
      getGeneration: () => (attempt === 0 ? 1 : attempt),
      setMemoryCache: () => {},
      setDiskCache: () => {},
    });
  });

  assert.deepEqual(graph, { attempt: 1 });
  assert.equal(starts, 2);
  assert.deepEqual(
    workers.map((worker) => worker.terminations),
    [1, 1]
  );
});

test('code-graph disk invalidation retries only once and releases both slots', async () => {
  let validations = 0;
  let releases = 0;
  await assert.rejects(
    _retryCodeGraphBuildAfterInvalidation(() =>
      _runDiskCodeGraphFastPath({
        graphCwd: process.cwd(),
        diskProbe: { isFastPathEligible: true, maxFiles: 7 },
        genAtStart: 0,
        loadDiskEntry: () => ({ maxFiles: 7 }),
        acquireSlot: async () => () => {
          releases += 1;
        },
        validateDiskHit: async () => {
          validations += 1;
          return { invalidated: true };
        },
        spawnWorker: () => {
          throw new Error('worker must not start for an invalidated disk hit');
        },
        maxFiles: 7,
      })
    ),
    { code: 'ERR_CODE_GRAPH_BUILD_INVALIDATED' }
  );

  assert.equal(validations, 2);
  assert.equal(releases, 2);
});

test('code-graph answers from the last finished graph when files keep changing, without caching it', async () => {
  let starts = 0;
  let cacheWrites = 0;
  const graph = await _retryCodeGraphBuildAfterInvalidation(async () => {
    const attempt = starts++;
    return _spawnCodeGraphWorker(process.cwd(), process.cwd(), attempt, null, null, null, {
      createWorker() {
        const worker = new FakeWorker();
        queueMicrotask(() => worker.emit('message', { ok: true, graph: { attempt }, signature: `sig-${attempt}` }));
        return worker;
      },
      // Every build finishes after another edit bumped the generation.
      getGeneration: () => attempt + 1,
      setMemoryCache: () => {
        cacheWrites += 1;
      },
      setDiskCache: () => {
        cacheWrites += 1;
      },
    });
  });
  assert.deepEqual(graph, { attempt: 1 });
  assert.equal(starts, 2);
  assert.equal(cacheWrites, 0);

  let validations = 0;
  const diskGraph = await _retryCodeGraphBuildAfterInvalidation(() =>
    _runDiskCodeGraphFastPath({
      graphCwd: process.cwd(),
      diskProbe: { isFastPathEligible: true, maxFiles: 7 },
      genAtStart: 0,
      loadDiskEntry: () => ({ maxFiles: 7 }),
      acquireSlot: async () => () => {},
      validateDiskHit: async () => ({ invalidated: true, graph: { disk: ++validations } }),
      spawnWorker: () => {
        throw new Error('worker must not start for an invalidated disk hit');
      },
      maxFiles: 7,
    })
  );
  assert.deepEqual(diskGraph, { disk: 2 });
});

test('sentinel-free aggregate anchors adopt only their explicit bounded cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-codegraph-bounded-'));
  const outside = mkdtempSync(join(tmpdir(), 'mixdog-codegraph-outside-'));
  try {
    mkdirSync(join(root, 'src'));
    const first = join(root, 'src', 'first.ts');
    const second = join(root, 'src', 'second.ts');
    const foreign = join(outside, 'foreign.ts');
    writeFileSync(first, 'export const first = 1;\n');
    writeFileSync(second, 'export const second = 2;\n');
    writeFileSync(foreign, 'export const foreign = 3;\n');

    assert.equal(_resolveBoundedSentinelFreeAggregateRootForTest({ files: [first, second] }, root), resolve(root));
    assert.equal(_resolveBoundedSentinelFreeAggregateRootForTest({ files: [first, foreign] }, root), null);
    assert.equal(_resolveBoundedSentinelFreeAggregateRootForTest({ files: ['src/*.ts'] }, root), null);

    mkdirSync(join(root, 'nested-project'));
    writeFileSync(join(root, 'nested-project', 'package.json'), '{}\n');
    assert.equal(_resolveBoundedSentinelFreeAggregateRootForTest({ files: [first] }, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
