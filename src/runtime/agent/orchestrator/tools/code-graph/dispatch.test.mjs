import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _resolveBoundedSentinelFreeAggregateRootForTest } from './dispatch.mjs';
import { _spawnCodeGraphWorker } from './build.mjs';

test('successful code-graph build terminates its worker and releases the spawn slot', async () => {
  let worker = null;
  let releases = 0;
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

  const pending = _spawnCodeGraphWorker(
    process.cwd(),
    process.cwd(),
    0,
    null,
    () => { releases += 1; },
    null,
    null,
    {
      createWorker() {
        worker = new FakeWorker();
        return worker;
      },
      getGeneration: () => 0,
      setMemoryCache: () => {},
      setDiskCache: () => {},
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  worker.emit('message', { ok: true, graph: { files: [] }, signature: 'sig' });

  assert.deepEqual(await pending, { files: [] });
  assert.equal(worker.terminations, 1);
  assert.equal(releases, 1);
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

    assert.equal(
      _resolveBoundedSentinelFreeAggregateRootForTest({ files: [first, second] }, root),
      resolve(root),
    );
    assert.equal(
      _resolveBoundedSentinelFreeAggregateRootForTest({ files: [first, foreign] }, root),
      null,
    );
    assert.equal(
      _resolveBoundedSentinelFreeAggregateRootForTest({ files: ['src/*.ts'] }, root),
      null,
    );

    mkdirSync(join(root, 'nested-project'));
    writeFileSync(join(root, 'nested-project', 'package.json'), '{}\n');
    assert.equal(
      _resolveBoundedSentinelFreeAggregateRootForTest({ files: [first] }, root),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
