// A failed line-diff worker request (crash, transport error) degrades a file
// exactly like a diff timeout instead of failing the turn's seal.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-line-diff-failure-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => {
  rmSync(base, { recursive: true, force: true });
});

mock.module(new URL('./line-diff.mjs', import.meta.url).href, {
  namedExports: {
    structuredPatchOffThread: async () => {
      throw Object.assign(new Error('worker exited (1)'), { code: 'EWORKEREXIT' });
    },
  },
});
const { _resetTurnSnapshotForTest, beginTurnSnapshot, completeTurnSnapshot, getTurnChanges, recordTurnDiffChanges } =
  await import('./turn-snapshot.mjs');

test('a failed line-diff worker request still writes the record, with the diff-timeout fallback', async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'line-diff-failure';
  const root = join(base, 'plain');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'A\n');
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  const live = await recordTurnDiffChanges(sessionId, [
    { path: join(root, 'a.txt'), displayPath: 'a.txt', before: 'a\n', after: 'A\n' },
  ]);
  assert.equal(live, 'diff --git a/a.txt b/a.txt\nBinary files a/a.txt and b/a.txt differ\n');
  assert.equal(await completeTurnSnapshot(sessionId), true);

  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.status, 'ready');
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.status, file.revertable, file.reason]),
    [['a.txt', 'M', false, 'the diff took too long to compute']]
  );
  assert.equal(reply.canUndo, false);
});
