import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { fileOf, isolateDataDir, replace, saveIndexed, sessionsDir } from './store-summary-reader-catalog-fixture.mjs';
import {
  clearStoredSessionCatalog,
  listStoredSessionSummariesAsync,
  listStoredSessionSummaryPage,
  listStoredSessionSummaries,
} from './store-summary-reader.mjs';

// The daemon answers a listing from the JSON catalog while its catalog DB is
// not ready (warm-up). The cold build of that catalog strict-reads and cleans
// every session record: blocking reads on the loop made it one stretch that
// grew with the store. Its reads must be awaited ones, and what it lists must
// stay exactly what the blocking build lists.
function spySessionFileBlockingReads(t) {
  const original = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function (path, ...rest) {
    if (String(path).startsWith(sessionsDir())) reads.push(String(path));
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return reads;
}

function populate(count) {
  for (let index = 0; index < count; index += 1) {
    const id = `sess_cold_${String(index).padStart(3, '0')}`;
    replace(id, `<system-reminder>hidden</system-reminder> prompt ${index}`);
  }
}

test('the cold JSON listing reads no session file on the loop and lists what the blocking build lists', async (t) => {
  isolateDataDir('mixdog-cold-listing-');
  populate(24);
  const reads = spySessionFileBlockingReads(t);

  const rows = await listStoredSessionSummariesAsync();
  assert.deepEqual(reads, [], 'no blocking session-file read');
  assert.equal(rows.length, 24);

  clearStoredSessionCatalog();
  assert.deepEqual(rows, listStoredSessionSummaries());
  assert.equal(reads.length, 24, 'the blocking build is what the spy would have caught');
});

test('the cold JSON page reads no session file on the loop', async (t) => {
  isolateDataDir('mixdog-cold-page-');
  populate(8);
  const reads = spySessionFileBlockingReads(t);
  const page = await listStoredSessionSummaryPage({ limit: 5 });
  assert.deepEqual(reads, []);
  assert.equal(page.sessions.length, 5);
  assert.ok(page.nextCursor);
});

/** Runs `onCall(path)` just before the awaited `fsp.stat` of each path in `watch`. */
function hookAwaitedCalls(t, { stat, readdir }) {
  const original = { stat: fsp.stat, readdir: fsp.readdir };
  fsp.stat = async function (path, ...rest) {
    stat?.(String(path));
    return original.stat.call(this, path, ...rest);
  };
  fsp.readdir = async function (path, ...rest) {
    readdir?.(String(path));
    return original.readdir.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsp.stat = original.stat;
    fsp.readdir = original.readdir;
    syncBuiltinESMExports();
  });
}

// The catalog is as fresh as the steady state makes any catalog: a save finds
// its index upsert, a create/delete finds the directory stamp (a raw rename
// over an existing name, with no index upsert, is the background
// verification's, as for a catalog that has been up for a while).
test('writes landing during the last stat of the cold build are in the listing, read without blocking', async (t) => {
  isolateDataDir('mixdog-cold-race-');
  populate(10);
  const last = fileOf('sess_cold_009');
  let listings = 0;
  let injected = false;
  hookAwaitedCalls(t, {
    readdir: (path) => {
      if (path === sessionsDir()) listings += 1;
    },
    stat: (path) => {
      // The settling pass's stat of the last file: the build's final look.
      if (injected || path !== last || listings < 2) return;
      injected = true;
      // A save of the store (record, then its index upsert) and a new file.
      saveIndexed('sess_cold_000', 'replaced after its settle stat');
      replace('sess_cold_new', 'added after the listing');
    },
  });
  const reads = spySessionFileBlockingReads(t);

  const rows = await listStoredSessionSummariesAsync();
  assert.ok(injected, 'the writes landed inside the build');
  assert.deepEqual(reads, [], 'no blocking session-file read, including the reconcile');
  const preview = (id) => rows.find((row) => row.id === id)?.preview;
  assert.equal(preview('sess_cold_000'), 'replaced after its settle stat');
  assert.equal(preview('sess_cold_new'), 'added after the listing');

  clearStoredSessionCatalog();
  assert.deepEqual(rows, listStoredSessionSummaries(), 'what a blocking build at this moment lists');
});

test('a clear() during the cold build starts a new awaited build that every waiter follows', async (t) => {
  isolateDataDir('mixdog-cold-clear-');
  populate(10);
  let cleared = false;
  let second;
  hookAwaitedCalls(t, {
    readdir: (path) => {
      if (cleared || path !== sessionsDir()) return;
      cleared = true;
      clearStoredSessionCatalog();
      second = listStoredSessionSummariesAsync();
    },
  });
  const reads = spySessionFileBlockingReads(t);

  const first = listStoredSessionSummariesAsync();
  const a = await first;
  const b = await second;
  assert.ok(cleared);
  assert.deepEqual(reads, [], 'no blocking session-file read');
  assert.equal(a.length, 10);
  assert.deepEqual(a, b);
});
test('the cold build ends in work bounded by the store while saves keep landing', async (t) => {
  isolateDataDir('mixdog-cold-churn-');
  const count = 40;
  populate(count);
  let sessionStats = 0;
  let writes = 0;
  hookAwaitedCalls(t, {
    stat: (path) => {
      if (!path.endsWith('.json') || !path.startsWith(sessionsDir())) return;
      sessionStats += 1;
      // A writer renaming a session over its name every few stats, as long as
      // the build keeps going (capped so a loop that never ends still fails
      // here rather than hanging).
      if (sessionStats % 5 === 0 && writes < 50 * count) {
        replace(`sess_cold_${String(writes % count).padStart(3, '0')}`, `rewritten ${writes}`);
        writes += 1;
      }
    },
  });
  const reads = spySessionFileBlockingReads(t);

  const rows = await listStoredSessionSummariesAsync();
  assert.equal(rows.length, count);
  assert.deepEqual(reads, []);
  assert.ok(sessionStats <= 4 * count, `${sessionStats} session stats for ${count} sessions`);
  assert.ok(writes > 0, 'saves landed while it ran');
});