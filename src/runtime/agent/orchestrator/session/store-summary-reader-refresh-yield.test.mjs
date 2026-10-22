import assert from 'node:assert/strict';
import test from 'node:test';

import { unlinkSync } from 'node:fs';

import { fileOf, isolateDataDir, replace, rewriteInPlace, spyFs } from './store-summary-reader-catalog-fixture.mjs';
import * as catalog from './store-summary-catalog.mjs';
import { listStoredSessionSummaries, listStoredSessionSummariesAsync } from './store-summary-reader.mjs';

// The daemon's session.list storage refresh strict-reads every session file
// (≈4 s on a 1.8k-file store): its async form must hand the event loop back
// between slices and still answer exactly what the sync rescan answers.
test('the async storage refresh yields between files and answers the sync rescan', async (t) => {
  isolateDataDir('mixdog-refresh-yield-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  catalog._setCatalogScanSliceMsForTest?.(0);
  t.after(() => catalog._setCatalogScanSliceMsForTest?.(25));
  let turns = 0;
  let running = true;
  const count = () => {
    if (!running) return;
    turns += 1;
    setImmediate(count);
  };
  setImmediate(count);
  const rows = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  running = false;
  assert.ok(turns >= 10, `the loop ran ${turns} turns during the rescan`);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows, listStoredSessionSummaries({ refreshFromStorage: true }));
});

/** Runs `change` once the rescan has yielded `afterTurns` times (by then it
 *  has read the first files), then awaits the rescan. */
async function refreshWhile(t, change, afterTurns = 4) {
  catalog._setCatalogScanSliceMsForTest?.(0);
  t.after(() => catalog._setCatalogScanSliceMsForTest?.(25));
  let turns = 0;
  const step = () => {
    turns += 1;
    if (turns === afterTurns) change();
    else setImmediate(step);
  };
  setImmediate(step);
  const rows = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.ok(turns >= afterTurns, 'the change landed while the rescan was running');
  return rows;
}

const ids = (rows) => rows.map((row) => row.id).sort();

// What a yielding rescan returns must be storage as it is when it returns,
// exactly as the one-piece rescan's answer is.
test('a session deleted during the rescan is not in its answer', async (t) => {
  isolateDataDir('mixdog-refresh-delete-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const rows = await refreshWhile(t, () => unlinkSync(fileOf('sess_yield_0')));
  assert.ok(!ids(rows).includes('sess_yield_0'));
  assert.deepEqual(rows, listStoredSessionSummaries({ refreshFromStorage: true }));
});

test('a session created during the rescan is in its answer', async (t) => {
  isolateDataDir('mixdog-refresh-create-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const rows = await refreshWhile(t, () => replace('sess_yield_00', 'created mid-scan'));
  assert.ok(ids(rows).includes('sess_yield_00'));
  assert.deepEqual(rows, listStoredSessionSummaries({ refreshFromStorage: true }));
});

test('a session rewritten during the rescan answers its new content', async (t) => {
  isolateDataDir('mixdog-refresh-rewrite-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const rows = await refreshWhile(t, () => rewriteInPlace('sess_yield_0', 'rewritten mid-scan, longer'));
  assert.equal(rows.find((row) => row.id === 'sess_yield_0')?.preview, 'rewritten mid-scan, longer');
  assert.deepEqual(rows, listStoredSessionSummaries({ refreshFromStorage: true }));
});

// A rescan that never yields has settled before its caller even awaits it; a
// refresh asked after a write must not be handed that earlier answer.
test('a refresh asked after a settled rescan does not join it', async (t) => {
  isolateDataDir('mixdog-refresh-late-join-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  catalog._setCatalogScanSliceMsForTest?.(60_000);
  t.after(() => catalog._setCatalogScanSliceMsForTest?.(25));
  const first = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  rewriteInPlace('sess_yield_0', 'after the write, longer');
  const second = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  const preview = (rows) => rows.find((row) => row.id === 'sess_yield_0')?.preview;
  assert.equal(preview(await first), 'prompt 0');
  assert.equal(preview(await second), 'after the write, longer');
});

test('concurrent refreshes share one rescan and both answer storage when it ends', async (t) => {
  isolateDataDir('mixdog-refresh-concurrent-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  catalog._setCatalogScanSliceMsForTest?.(0);
  t.after(() => catalog._setCatalogScanSliceMsForTest?.(25));
  const counts = spyFs(t);
  await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  const oneRefresh = counts.readdirs;
  counts.readdirs = 0;

  const first = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  await new Promise((resolve) => setImmediate(resolve));
  unlinkSync(fileOf('sess_yield_0'));
  const second = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(counts.readdirs, oneRefresh, 'the second caller joined the running rescan');
  const now = listStoredSessionSummaries({ refreshFromStorage: true });
  assert.deepEqual(a, now);
  assert.deepEqual(b, now);
  assert.notEqual(a, b, 'each caller gets its own rows');
  assert.notEqual(a[0], b[0]);
});
