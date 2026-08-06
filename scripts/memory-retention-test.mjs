import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-memory-retention-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const turnSnapshots = await import('../src/runtime/shared/turn-snapshot.mjs');
const readSnapshots = await import('../src/runtime/agent/orchestrator/tools/builtin/snapshot-store.mjs');

after(async () => {
  turnSnapshots._resetTurnSnapshotForTest();
  readSnapshots._resetReadSnapshotStoreForTest();
  await rm(dataDir, { recursive: true, force: true });
});

test('completed Lead and Agent reviews release tracked file buffers', async () => {
  turnSnapshots._resetTurnSnapshotForTest();
  await turnSnapshots.beginTurnSnapshot('C:/project', 'lead-memory');
  turnSnapshots.recordTurnDiffChanges('lead-memory', [{
    path: 'C:/project/src/a.mjs',
    displayPath: 'src/a.mjs',
    before: Buffer.from('old\n'),
    after: Buffer.from('new\n'),
  }]);
  assert.ok(turnSnapshots._turnSnapshotStatsForTest('lead-memory').trackedBytes > 0);
  assert.equal(await turnSnapshots.completeTurnSnapshot('lead-memory'), true);
  assert.equal(turnSnapshots._turnSnapshotStatsForTest('lead-memory').trackedBytes, 0);
  assert.match((await turnSnapshots.getTurnReviewDiff('C:/project', 'lead-memory')).patch, /\+new/);

  const worker = turnSnapshots.beginAgentTurnReview('lead-memory', 'worker-memory', { agent: 'worker' });
  turnSnapshots.recordTurnDiffChanges('worker-memory', [{
    path: 'C:/project/src/worker.mjs',
    displayPath: 'src/worker.mjs',
    before: Buffer.from('before\n'),
    after: Buffer.from('after\n'),
  }]);
  assert.equal(turnSnapshots.completeAgentTurnReview(worker), true);
  assert.equal(turnSnapshots._turnSnapshotStatsForTest('worker-memory'), null);
});

test('read snapshot scopes, files, and redirects remain bounded and releasable', () => {
  readSnapshots._resetReadSnapshotStoreForTest();
  const snapshot = {
    mtimeMs: 1,
    ctimeMs: 1,
    size: 1,
    ranges: [{ startLine: 1, endLine: 1 }],
  };
  for (let index = 0; index < readSnapshots.READ_SNAPSHOT_SCOPE_CACHE_LIMIT + 4; index += 1) {
    const scope = `memory-scope-${process.pid}-${index}`;
    const files = readSnapshots.readFilesForScope(scope);
    readSnapshots.rememberReadSnapshot(`C:/project/${index}.mjs`, snapshot, scope, files);
  }
  assert.ok(
    readSnapshots._readSnapshotStoreStatsForTest().scopeCount
      <= readSnapshots.READ_SNAPSHOT_SCOPE_CACHE_LIMIT,
  );

  const scope = `memory-active-${process.pid}`;
  const files = readSnapshots.readFilesForScope(scope);
  for (let index = 0; index < readSnapshots.READ_SNAPSHOT_FILES_PER_SCOPE_LIMIT + 8; index += 1) {
    readSnapshots.rememberReadSnapshot(`C:/project/active-${index}.mjs`, snapshot, scope, files);
  }
  assert.equal(
    readSnapshots._readSnapshotStoreStatsForTest(scope).fileCount,
    readSnapshots.READ_SNAPSHOT_FILES_PER_SCOPE_LIMIT,
  );
  const target = `C:/project/active-${readSnapshots.READ_SNAPSHOT_FILES_PER_SCOPE_LIMIT + 7}.mjs`;
  for (let index = 0; index < readSnapshots.READ_SNAPSHOT_REDIRECTS_PER_SCOPE_LIMIT + 8; index += 1) {
    readSnapshots.recordReadPathRedirect(`C:/missing/${index}.mjs`, target, scope);
  }
  assert.equal(
    readSnapshots._readSnapshotStoreStatsForTest(scope).redirectCount,
    readSnapshots.READ_SNAPSHOT_REDIRECTS_PER_SCOPE_LIMIT,
  );
  assert.equal(readSnapshots.releaseReadSnapshotScope(scope, { deletePersisted: true }), true);
  assert.equal(readSnapshots._readSnapshotStoreStatsForTest(scope).fileCount, 0);
});

test('persistent diagnostic probe owns parent and CDP shutdown guards', async () => {
  const source = await readFile(
    new URL('../apps/desktop/scripts/probe-daemon.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /parentWatchTimer = setInterval/);
  assert.match(source, /socket\.addEventListener\('close'/);
  assert.match(source, /pending\.delete\(id\)/);
  assert.match(source, /CDP request timed out/);
});
