// The daemon's main thread does no filesystem work and no SQLite work for an
// ordinary listing once the catalog DB answers: full listings and pages are
// one worker request each. (Filesystem calls are counted on this thread only;
// node:sqlite's module list is per thread, so only the worker loads it.)
import assert from 'node:assert/strict';
import test from 'node:test';

import * as fixture from '../store-summary-reader-catalog-fixture.mjs';
import * as reader from '../store-summary-reader.mjs';
import * as catalogDb from './index.mjs';

const sqliteLoaded = () => process.moduleLoadList.some((entry) => /\bsqlite\b/.test(entry));

test('an ordinary listing costs the main thread no fs call and no SQLite call', async (t) => {
  fixture.isolateDataDir('mixdog-catalog-db-main-thread-');
  fixture.writeBase([]);
  catalogDb.configureSessionCatalogDbForTest({ writer: true, sqliteVersion: '3.51.3', log: () => {} });
  t.after(async () => {
    await catalogDb.closeSessionCatalogDb();
    catalogDb.configureSessionCatalogDbForTest(null);
  });
  for (const [index, id] of ['lead_a', 'lead_b', 'lead_c', 'lead_d', 'lead_e'].entries()) {
    fixture.replace(id, id);
    fixture.appendLog([{ ...fixture.indexRow(id, id), lastUsedAt: 100 + index }]);
  }
  const db = catalogDb.sessionCatalogDb(process.env.MIXDOG_DATA_DIR);
  await db.list();
  assert.equal((await db.settled()).phase, 'ready');
  const expected = reader.listStoredSessionSummaries();
  reader.clearStoredSessionCatalog();

  const counts = fixture.spyFs(t);
  const rows = await reader.listStoredSessionSummariesAsync();
  const page = await reader.listStoredSessionSummaryPage({ limit: 2 });
  // Another process writes: the next listing still costs this thread nothing.
  counts.stats = 0;
  fixture.replace('lead_f', 'lead_f');
  const afterWrite = await reader.listStoredSessionSummariesAsync();

  assert.deepEqual(
    { stats: counts.stats, readdirs: counts.readdirs, reads: counts.reads, asyncStats: counts.asyncStats },
    { stats: 0, readdirs: 0, reads: 0, asyncStats: 0 }
  );
  assert.deepEqual(rows, expected);
  assert.deepEqual(
    page.sessions.map((row) => row.id),
    ['lead_e', 'lead_d']
  );
  assert.ok(page.nextCursor);
  assert.ok(
    afterWrite.some((row) => row.id === 'lead_f'),
    'the external write is on the next listing'
  );
  assert.equal(sqliteLoaded(), false, 'node:sqlite never loaded on the main thread');
});
