import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _isCompatibleDiskCodeGraphEntry,
  _postCodeGraphWorkerSuccess,
  _prepareDiskCodeGraphFastPath,
  _runDiskCodeGraphFastPath,
  _validateDiskCodeGraphHit,
} from '../src/runtime/agent/orchestrator/tools/code-graph/build.mjs';
import { CODE_GRAPH_MAX_FILES } from '../src/runtime/agent/orchestrator/tools/code-graph/constants.mjs';
import { _serializeGraph } from '../src/runtime/agent/orchestrator/tools/code-graph/graph-model.mjs';
import { _persistDiskCodeGraphCacheNow } from '../src/runtime/agent/orchestrator/tools/code-graph/disk-cache.mjs';

test('signature-validated disk hit restores memory without a Worker build', async () => {
  const graph = { nodes: new Map() };
  let restored = null;
  const result = await _validateDiskCodeGraphHit({
    graphCwd: '/project',
    diskEntry: { signature: 'sig', maxFiles: CODE_GRAPH_MAX_FILES },
    genAtStart: 4,
    now: 123,
    runManifest: async () => [{ rel: 'a.mjs', fp: '1' }],
    computeSignature: () => 'sig',
    deserializeGraph: () => graph,
    getGeneration: () => 4,
    setMemoryCache: (cwd, entry) => { restored = { cwd, entry }; },
  });
  assert.equal(result.graph, graph);
  assert.deepEqual(restored, {
    cwd: '/project',
    entry: { ts: 123, signature: 'sig', graph },
  });
});

test('disk mismatch hands one manifest to the isolated rebuild without restoring stale data', async () => {
  let deserialized = false;
  const manifest = [{ rel: 'changed.mjs', fp: '2' }];
  const result = await _validateDiskCodeGraphHit({
    graphCwd: '/project',
    diskEntry: { signature: 'old', maxFiles: CODE_GRAPH_MAX_FILES },
    genAtStart: 1,
    runManifest: async () => manifest,
    computeSignature: () => 'new',
    deserializeGraph: () => { deserialized = true; },
  });
  assert.equal(result.graph, null);
  assert.equal(result.manifest, manifest);
  assert.equal(result.signature, 'new');
  assert.equal(deserialized, false);
});

test('generation change rejects a validated stale disk graph', async () => {
  const result = await _validateDiskCodeGraphHit({
    graphCwd: '/project',
    diskEntry: { signature: 'sig', maxFiles: CODE_GRAPH_MAX_FILES },
    genAtStart: 1,
    runManifest: async () => [],
    computeSignature: () => 'sig',
    deserializeGraph: () => ({ nodes: new Map() }),
    getGeneration: () => 2,
  });
  assert.deepEqual(result, { invalidated: true });
});

function fastProbe(overrides = {}) {
  return { isFastPathEligible: true, maxFiles: CODE_GRAPH_MAX_FILES, bytes: 1, ...overrides };
}

test('validated hit releases its pre-acquired slot exactly once', async () => {
  let releases = 0;
  let workers = 0;
  const result = await _runDiskCodeGraphFastPath({
    graphCwd: '/project',
    diskProbe: fastProbe(),
    genAtStart: 1,
    loadDiskEntry: () => ({ maxFiles: CODE_GRAPH_MAX_FILES }),
    acquireSlot: async () => () => { releases++; },
    validateDiskHit: async () => ({ graph: 'hit' }),
    spawnWorker: () => { workers++; },
  });
  assert.equal(result, 'hit');
  assert.equal(releases, 1);
  assert.equal(workers, 0);
});

test('validation errors release the pre-acquired slot', async () => {
  let releases = 0;
  await assert.rejects(_runDiskCodeGraphFastPath({
    graphCwd: '/project',
    diskProbe: fastProbe(),
    genAtStart: 1,
    loadDiskEntry: () => ({ maxFiles: CODE_GRAPH_MAX_FILES }),
    acquireSlot: async () => () => { releases++; },
    validateDiskHit: async () => { throw new Error('manifest failed'); },
    spawnWorker: () => assert.fail('Worker must not start'),
  }), /manifest failed/);
  assert.equal(releases, 1);
});

test('validated miss hands its slot to Worker exactly once', async () => {
  let releases = 0;
  let receivedRelease = null;
  const result = await _runDiskCodeGraphFastPath({
    graphCwd: '/project',
    diskProbe: fastProbe(),
    genAtStart: 1,
    loadDiskEntry: () => ({ maxFiles: CODE_GRAPH_MAX_FILES }),
    acquireSlot: async () => () => { releases++; },
    validateDiskHit: async () => ({ graph: null, manifest: ['one'], signature: 'new' }),
    spawnWorker: (release, manifest, signature) => {
      receivedRelease = release;
      assert.deepEqual(manifest, ['one']);
      assert.equal(signature, 'new');
      return 'worker-result';
    },
  });
  assert.equal(result, 'worker-result');
  assert.equal(releases, 0);
  receivedRelease();
  assert.equal(releases, 1);
});

test('abort after slot acquisition or validation releases the slot and never starts a Worker', async () => {
  for (const abortAt of ['acquire', 'validate']) {
    const controller = new AbortController();
    let releases = 0;
    let workers = 0;
    await assert.rejects(_runDiskCodeGraphFastPath({
      graphCwd: '/project',
      diskProbe: fastProbe(),
      genAtStart: 1,
      signal: controller.signal,
      loadDiskEntry: () => ({ maxFiles: CODE_GRAPH_MAX_FILES }),
      acquireSlot: async () => {
        if (abortAt === 'acquire') controller.abort();
        return () => { releases++; };
      },
      validateDiskHit: async () => {
        if (abortAt === 'validate') controller.abort();
        return { graph: 'hit' };
      },
      spawnWorker: () => { workers++; },
    }), /aborted/);
    assert.equal(releases, 1, abortAt);
    assert.equal(workers, 0, abortAt);
  }
});

test('oversized or maxFiles-incompatible entries bypass main-thread load and use Worker', async () => {
  for (const probe of [fastProbe({ isFastPathEligible: false }), fastProbe({ maxFiles: null })]) {
    let loaded = 0;
    let acquired = 0;
    const result = await _runDiskCodeGraphFastPath({
      graphCwd: '/project',
      diskProbe: probe,
      genAtStart: 1,
      loadDiskEntry: () => { loaded++; return { maxFiles: CODE_GRAPH_MAX_FILES }; },
      acquireSlot: async () => { acquired++; return () => {}; },
      spawnWorker: (release) => ({ release }),
    });
    assert.deepEqual(result, { release: null });
    assert.equal(loaded, 0);
    assert.equal(acquired, 0);
  }
});

test('persisted entries require matching maxFiles in both cache paths', () => {
  assert.equal(_isCompatibleDiskCodeGraphEntry({ maxFiles: CODE_GRAPH_MAX_FILES }), true);
  assert.equal(_isCompatibleDiskCodeGraphEntry({}), false);
  assert.equal(_isCompatibleDiskCodeGraphEntry({ maxFiles: CODE_GRAPH_MAX_FILES - 1 }), false);
  assert.equal(_serializeGraph({ nodes: new Map() }).maxFiles, CODE_GRAPH_MAX_FILES);
});

test('large legacy cache bypasses parent migration/parser and routes directly to Worker', () => {
  let migrationOrParserCalls = 0;
  let probeCalls = 0;
  const result = _prepareDiskCodeGraphFastPath({
    graphCwd: '/project',
    hasLegacyCache: () => true,
    ensureDiskLoaded: () => { migrationOrParserCalls++; },
    probeDiskEntry: () => { probeCalls++; return assert.fail('legacy probe must not run'); },
    runFastPath: (probe) => ({ probe, route: 'worker' }),
  });
  assert.deepEqual(result, { probe: null, route: 'worker' });
  assert.equal(migrationOrParserCalls, 0);
  assert.equal(probeCalls, 0);
});

test('Worker drains all migrated cache entries before posting success', () => {
  const migratedEntries = new Map([
    ['/requested', { signature: 'requested' }],
    ['/legacy-project', { signature: 'legacy' }],
  ]);
  const events = [];
  _postCodeGraphWorkerSuccess(
    { signature: 'requested', nodes: new Map() },
    (message) => {
      events.push('post');
      assert.equal(migratedEntries.size, 2);
      assert.equal(message.ok, true);
    },
    () => {
      events.push('drain');
      assert.deepEqual([...migratedEntries.keys()], ['/requested', '/legacy-project']);
    },
  );
  assert.deepEqual(events, ['drain', 'post']);
});

test('strict persistence failure prevents Worker success post', () => {
  let posted = false;
  assert.throws(
    () => _postCodeGraphWorkerSuccess(
      { signature: 'requested' },
      () => { posted = true; },
      () => _persistDiskCodeGraphCacheNow({
        strict: true,
        writeJson: () => { throw new Error('persist failed'); },
      }),
    ),
    /persist failed/,
  );
  assert.equal(posted, false);
});
