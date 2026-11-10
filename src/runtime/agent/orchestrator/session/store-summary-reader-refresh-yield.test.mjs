import assert from 'node:assert/strict';
import test from 'node:test';

import { unlinkSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

import { fileOf, isolateDataDir, replace, rewriteInPlace, spyFs } from './store-summary-reader-catalog-fixture.mjs';
import { listStoredSessionSummariesAsync } from './store-summary-reader.mjs';

// The daemon's session.list storage refresh strict-reads every session file
// (≈4 s on a 1.8k-file store): it must hand the event loop back between
// slices and still answer exactly what a rescan of the settled store answers.
test('the storage refresh yields between files and answers a rescan of the settled store', async () => {
  isolateDataDir('mixdog-refresh-yield-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
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
  assert.deepEqual(rows, await listStoredSessionSummariesAsync({ refreshFromStorage: true }));
});

/** Runs `change` once the rescan has yielded `afterTurns` times (by then it
 *  has read the first files), then awaits the rescan. */
async function refreshWhile(change, afterTurns = 4) {
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
test('a session deleted during the rescan is not in its answer', async () => {
  isolateDataDir('mixdog-refresh-delete-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const rows = await refreshWhile(() => unlinkSync(fileOf('sess_yield_0')));
  assert.ok(!ids(rows).includes('sess_yield_0'));
  assert.deepEqual(rows, await listStoredSessionSummariesAsync({ refreshFromStorage: true }));
});

test('a session created during the rescan is in its answer', async () => {
  isolateDataDir('mixdog-refresh-create-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const rows = await refreshWhile(() => replace('sess_yield_00', 'created mid-scan'));
  assert.ok(ids(rows).includes('sess_yield_00'));
  assert.deepEqual(rows, await listStoredSessionSummariesAsync({ refreshFromStorage: true }));
});

test('a session rewritten during the rescan answers its new content', async () => {
  isolateDataDir('mixdog-refresh-rewrite-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const rows = await refreshWhile(() => rewriteInPlace('sess_yield_0', 'rewritten mid-scan, longer'));
  assert.equal(rows.find((row) => row.id === 'sess_yield_0')?.preview, 'rewritten mid-scan, longer');
  assert.deepEqual(rows, await listStoredSessionSummariesAsync({ refreshFromStorage: true }));
});

// A refresh asked after a write must not be handed an answer settled before
// that write: once the rescan's final pass has begun, a new caller gets a
// rescan of its own.
test('a refresh asked after a settled rescan does not join it', async (t) => {
  isolateDataDir('mixdog-refresh-late-join-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
  const preview = (rows) => rows.find((row) => row.id === 'sess_yield_0')?.preview;
  // The rescan's final pass begins by listing the directory again.
  const readdir = fsp.readdir;
  let listings = 0;
  let finalPassBegun;
  const begun = new Promise((resolve) => {
    finalPassBegun = resolve;
  });
  fsp.readdir = async function countedReaddir(...args) {
    listings += 1;
    if (listings === 2) finalPassBegun();
    return readdir.apply(this, args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsp.readdir = readdir;
    syncBuiltinESMExports();
  });
  const first = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  await begun;
  rewriteInPlace('sess_yield_0', 'after the write, longer');
  const second = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  await first;
  assert.equal(preview(await second), 'after the write, longer');
  assert.equal(listings, 4, 'the later caller ran a rescan of its own');
});

test('concurrent refreshes share one rescan and both answer storage when it ends', async (t) => {
  isolateDataDir('mixdog-refresh-concurrent-');
  for (let index = 0; index < 12; index += 1) replace(`sess_yield_${index}`, `prompt ${index}`);
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
  const now = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.deepEqual(a, now);
  assert.deepEqual(b, now);
  assert.notEqual(a, b, 'each caller gets its own rows');
  assert.notEqual(a[0], b[0]);
});
