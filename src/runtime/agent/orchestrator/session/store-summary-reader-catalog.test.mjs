// The ordinary (no refreshFromStorage) catalog answers an unchanged call from
// cheap stamps — summary index base + log and the sessions directory — and
// re-reconciles only what a changed stamp points at.
import assert from 'node:assert/strict';
import { statSync, unlinkSync, utimesSync } from 'node:fs';
import test from 'node:test';

import {
  appendLog,
  assertMatchesStorage,
  fileOf,
  indexRow,
  list,
  replace,
  rewriteInPlace,
  saveIndexed,
  settle,
  spyFs,
  isolateDataDir,
  view,
  writeBase,
} from './store-summary-reader-catalog-fixture.mjs';
import { subscribeStoredSessionCatalogChanges, verifyStoredSessionCatalog } from './store-summary-reader.mjs';

isolateDataDir('mixdog-reader-catalog-');

test('an unchanged call does no per-file filesystem work', async (t) => {
  replace('indexed_a', 'alpha');
  replace('plain_b', 'bravo');
  writeBase([indexRow('indexed_a', 'alpha')]);
  const expected = { indexed_a: 'indexed:alpha|alpha', plain_b: '|bravo' };
  assert.deepEqual(view(), expected);
  await settle();
  assert.deepEqual(view(), expected, 'the first call after the directory settled re-enumerates once');

  const counts = spyFs(t);
  const rows = list();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(view(rows), expected);
  assert.equal(counts.sessionFileStats.size, 0, 'no session file is stat-ed');
  assert.equal(counts.readdirs, 0, 'the directory is not enumerated');
  assert.equal(counts.reads, 0, 'nothing is read');
  assert.equal(counts.asyncStats, 0, 'no background pass within its interval');
  // sessions directory + index base + delta log (absent).
  assert.equal(counts.stats, 3);

  assert.throws(() => {
    rows[0].preview = 'mutated by a caller';
  }, TypeError);
  const deepFrozen = (value) =>
    !value || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));
  assert.ok(rows.every(deepFrozen), 'rows and everything in them are frozen');
  rows.pop();
  assert.deepEqual(view(), expected, 'a caller cannot change what the next caller gets');
});

test('an index-updating writer: create, rewrite and delete show on the next call', async (t) => {
  const counts = spyFs(t);
  saveIndexed('indexed_c', 'charlie');
  assert.equal(view().indexed_c, 'indexed:charlie|charlie');
  saveIndexed('indexed_c', 'charlie two');
  assert.equal(view().indexed_c, 'indexed:charlie two|charlie two');
  unlinkSync(fileOf('indexed_c'));
  appendLog([], ['indexed_c']);
  assert.equal(view().indexed_c, undefined);
  assertMatchesStorage();

  // The store flushes the index row after the rename: until it lands, the
  // name is unchanged and the previous row stands; the row then refreshes it
  // with one stat of that file.
  replace('indexed_a', 'alpha two');
  counts.sessionFileStats.clear();
  assert.equal(view().indexed_a, 'indexed:alpha|alpha');
  assert.equal(counts.sessionFileStats.size, 0, 'a namespace change re-stats nothing already listed');
  appendLog([indexRow('indexed_a', 'alpha two')]);
  assert.equal(view().indexed_a, 'indexed:alpha two|alpha two');
  assert.deepEqual([...counts.sessionFileStats], [fileOf('indexed_a')], 'only the changed row’s file');
});

test('a namespace change re-stats only the names that appeared', async (t) => {
  await settle();
  list();
  const counts = spyFs(t);
  replace('plain_g', 'golf');
  assert.equal(view().plain_g, '|golf');
  assert.deepEqual([...counts.sessionFileStats], [fileOf('plain_g')]);
  assert.equal(counts.readdirs, 1);
  counts.sessionFileStats.clear();
  unlinkSync(fileOf('plain_g'));
  assert.equal(view().plain_g, undefined);
  assert.equal(counts.sessionFileStats.size, 0, 'a vanished name is dropped without a stat');
  assertMatchesStorage();
});

test('a writer that never updates the index: create and delete at once, replacements by the background pass', async (t) => {
  let notified = 0;
  const unsubscribe = subscribeStoredSessionCatalogChanges(() => notified++);
  t.after(unsubscribe);
  replace('plain_d', 'delta');
  assert.equal(view().plain_d, '|delta');
  unlinkSync(fileOf('plain_d'));
  assert.equal(view().plain_d, undefined);
  await verifyStoredSessionCatalog();
  assert.equal(notified, 0, 'a pass that finds nothing new notifies nobody');

  // Rename-replace (an older build that skips the index) and an in-place
  // rewrite keep the name: the next background pass finds both, only those
  // files are reconciled, and subscribers are told to list again.
  const counts = spyFs(t);
  replace('indexed_a', 'alpha three');
  rewriteInPlace('plain_b', 'bravo two');
  assert.deepEqual(view(), { indexed_a: 'indexed:alpha two|alpha two', plain_b: '|bravo' }, 'stale until the pass');
  await verifyStoredSessionCatalog();
  assert.equal(counts.asyncStats, 2, 'the pass stats every file, off the listing');
  assert.equal(notified, 1);
  counts.sessionFileStats.clear();
  assert.deepEqual(view(), { indexed_a: '|alpha three', plain_b: '|bravo two' });
  assert.deepEqual([...counts.sessionFileStats].sort(), [fileOf('indexed_a'), fileOf('plain_b')]);
  assertMatchesStorage();
});

test('the background pass sees a same-size replacement with a preserved mtime', async () => {
  isolateDataDir('mixdog-reader-catalog-identity-');
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  replace('plain_h', 'hotel');
  utimesSync(fileOf('plain_h'), pinned, pinned);
  assert.equal(view().plain_h, '|hotel');
  const before = statSync(fileOf('plain_h'));
  replace('plain_h', 'HOTEL');
  utimesSync(fileOf('plain_h'), pinned, pinned);
  const after = statSync(fileOf('plain_h'));
  assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
  assert.notEqual(after.ino, before.ino, 'a replacement is a new file');
  assert.equal(view().plain_h, '|hotel', 'the name was listed already');
  await verifyStoredSessionCatalog();
  assert.equal(view().plain_h, '|HOTEL');
});

test('an indexed session replaced at equal length with a preserved mtime is re-read from the file', async () => {
  isolateDataDir('mixdog-reader-catalog-indexed-identity-');
  let notified = 0;
  const unsubscribe = subscribeStoredSessionCatalogChanges(() => notified++);
  try {
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    replace('indexed_i', 'aaaa');
    utimesSync(fileOf('indexed_i'), pinned, pinned);
    writeBase([indexRow('indexed_i', 'aaaa')]);
    assert.equal(view().indexed_i, 'indexed:aaaa|aaaa');
    replace('indexed_i', 'bbbb');
    utimesSync(fileOf('indexed_i'), pinned, pinned);
    await verifyStoredSessionCatalog();
    assert.equal(notified, 1);
    assert.equal(view().indexed_i, '|bbbb', 'the index row still matches size + mtime, but the file wins');
    assertMatchesStorage();
    await verifyStoredSessionCatalog();
    assert.equal(notified, 1, 'a later pass stays quiet');
    assert.equal(view().indexed_i, '|bbbb');
  } finally {
    unsubscribe();
  }
});

test('a listing during a background pass schedules the next pass', async (t) => {
  isolateDataDir('mixdog-reader-catalog-rearm-');
  replace('plain_v', 'victor');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let notified = 0;
  t.after(subscribeStoredSessionCatalogChanges(() => notified++));
  assert.equal(view().plain_v, '|victor');
  const pass = verifyStoredSessionCatalog();
  list();
  await pass;
  rewriteInPlace('plain_v', 'victor two');
  t.mock.timers.tick(10_000);
  for (let turn = 0; turn < 1_000 && notified === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, 1, 'the timer re-armed after the pass ran the next one');
  assert.equal(view().plain_v, '|victor two');
});
