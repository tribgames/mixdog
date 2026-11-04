// The save worker is a long-lived thread whose process.env was copied when it
// spawned. One process that runs several pristine headless sessions in turn
// (qc-pages: one page session per slide) moves MIXDOG_DATA_DIR between them
// and removes each run's root when it ends; a later session's save must land
// in ITS data dir, not in the first run's removed one.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const first = mkdtempSync(join(tmpdir(), 'mixdog-save-datadir-a-'));
const second = mkdtempSync(join(tmpdir(), 'mixdog-save-datadir-b-'));
process.env.MIXDOG_DATA_DIR = first;

const { saveSessionAsync } = await import('../store.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { releaseHeldSessionWriters } = await import('./session-writer-claim.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  releaseHeldSessionWriters();
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});

const makeSession = (id) => ({
  id,
  generation: 1,
  closed: false,
  messages: [{ role: 'user', content: id }],
});
const sessionFile = (root, id) => join(root, 'sessions', `${id}.json`);

test('a save after the data dir moved lands in the new dir, even once the old root is gone', async () => {
  await saveSessionAsync(makeSession('sess_datadir_first'), { expectedGeneration: 1 });
  assert.ok(existsSync(sessionFile(first, 'sess_datadir_first')), 'the first save lands in the first dir');

  process.env.MIXDOG_DATA_DIR = second;
  await settleSessionSummaryIndex();
  // The run ends (headless drain): its writer locks go before its root does.
  releaseHeldSessionWriters();
  rmSync(first, { recursive: true, force: true });

  await saveSessionAsync(makeSession('sess_datadir_second'), { expectedGeneration: 1 });
  assert.ok(existsSync(sessionFile(second, 'sess_datadir_second')), 'the second save lands in the second dir');
  assert.ok(!existsSync(first), 'nothing re-created the removed first root');
});
