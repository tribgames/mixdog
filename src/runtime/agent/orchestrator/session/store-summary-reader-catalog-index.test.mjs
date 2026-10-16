// The ordinary catalog against the summary index: unreadable records, a
// missing index, and index updates written by another process.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendLog,
  assertMatchesStorage,
  fileOf,
  indexPath,
  indexRow,
  list,
  logPath,
  replace,
  saveIndexed,
  sessionsDir,
  settle,
  spyFs,
  touchDirectory,
  useDataDir,
  view,
  writeBase,
} from './store-summary-reader-catalog-fixture.mjs';
import { encodeSummaryOps } from './store-summary-log.mjs';
import {
  clearStoredSessionCatalog,
  listStoredAgentWorkerLinks,
  listStoredSessionOwnershipLinksAsync,
  listStoredSessionSummaries,
  verifyStoredSessionCatalog,
} from './store-summary-reader.mjs';

test('an unreadable record keeps exactly the rows it kept before', async (t) => {
  useDataDir('mixdog-reader-catalog-unreadable-');
  replace('indexed_a', 'alpha');
  replace('plain_b', 'bravo');
  // The index row no longer describes the file: only unreadability retains it.
  writeBase([indexRow('indexed_a', 'alpha', { mtimeMs: 1, size: 1 })]);
  const failing = new Set([fileOf('indexed_a'), fileOf('plain_b')]);
  spyFs(t, failing);
  const expected = { indexed_a: 'indexed:alpha|alpha' };
  assert.deepEqual(view(), expected, 'indexed: the retained index row; never indexed: no row');
  assert.deepEqual(view(listStoredSessionSummaries({ refreshFromStorage: true })), expected);
  failing.clear();
  await verifyStoredSessionCatalog();
  assert.deepEqual(view(), { indexed_a: '|alpha', plain_b: '|bravo' }, 'readable again: the files win');
  failing.add(fileOf('plain_b'));
  touchDirectory();
  await verifyStoredSessionCatalog();
  assert.deepEqual(view(), { indexed_a: '|alpha' }, 'an unindexed record that turns unreadable has no row to keep');
});

test('usage ownership includes closed hidden children and stays unknown when storage cannot be read', async (t) => {
  useDataDir('mixdog-reader-usage-links-');
  replace('lead_usage', 'lead');
  writeFileSync(
    fileOf('child_usage'),
    JSON.stringify({
      id: 'child_usage',
      owner: 'agent',
      agent: 'worker',
      parentSessionId: 'lead_usage',
      closed: true,
      messages: [],
    })
  );
  const expected = [
    { id: 'child_usage', ownerSessionId: 'lead_usage' },
    { id: 'lead_usage', ownerSessionId: null },
  ];
  const links = async () => (await listStoredSessionOwnershipLinksAsync())?.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(await links(), expected);
  assert.deepEqual(list().map((row) => row.id), ['lead_usage'], 'ordinary visibility is unchanged');
  const failing = new Set([fileOf('child_usage')]);
  spyFs(t, failing);
  clearStoredSessionCatalog();
  assert.equal(await listStoredSessionOwnershipLinksAsync(), null, 'an unreadable child is not zero usage');
  failing.clear();
  clearStoredSessionCatalog();
  assert.deepEqual(await links(), expected);
  failing.add(sessionsDir());
  clearStoredSessionCatalog();
  assert.equal(await listStoredSessionOwnershipLinksAsync(), null, 'an unreadable directory is not an empty catalog');
});

test('complete worker ownership distinguishes absent, malformed and unreadable indexes', (t) => {
  useDataDir('mixdog-worker-usage-links-');
  const path = join(sessionsDir(), '..', 'agent-workers.json');
  const links = () => listStoredAgentWorkerLinks({ requireComplete: true });
  assert.deepEqual(links(), [], 'no index is a known empty pending-worker set');
  for (const text of ['{', '{}', '{"workers":[{}]}', '{"workers":[{"sessionId":"child","ownerSessionId":"bad id"}]}']) {
    writeFileSync(path, text);
    assert.equal(links(), null, text);
  }
  writeFileSync(path, JSON.stringify({ workers: [{ sessionId: 'child', ownerSessionId: 'lead' }] }));
  assert.deepEqual(links(), [{ sessionId: 'child', ownerSessionId: 'lead', parentSessionId: 'lead' }]);
  spyFs(t, new Set([path]));
  assert.equal(links(), null, 'an unreadable index must not discard unsaved child usage');
  assert.deepEqual(listStoredAgentWorkerLinks(), [], 'the migration caller keeps its best-effort contract');
});

test('the delta log: appended lines apply alone; a torn line or a rewritten log never loses an op', () => {
  useDataDir('mixdog-reader-catalog-log-');
  replace('log_x', 'xray');
  replace('log_y', 'yankee');
  writeBase([indexRow('log_x', 'xray'), indexRow('log_y', 'yankee')]);
  assert.deepEqual(view(), { log_x: 'indexed:xray|xray', log_y: 'indexed:yankee|yankee' });
  appendLog([{ ...indexRow('log_x', 'xray'), title: 'x one' }]);
  assert.equal(view().log_x, 'x one|xray');
  // A line still being appended is applied once it is whole.
  const line = encodeSummaryOps([{ ...indexRow('log_y', 'yankee'), title: 'y one' }], []);
  appendFileSync(logPath(), line.slice(0, -10));
  assert.equal(view().log_y, 'indexed:yankee|yankee');
  appendFileSync(logPath(), line.slice(-10));
  assert.equal(view().log_y, 'y one|yankee');
  // Rewritten in place and longer than before (truncate + regrow under the
  // same base): the earlier ops are gone, so it is replayed from the start.
  writeFileSync(
    logPath(),
    encodeSummaryOps([{ ...indexRow('log_y', 'yankee'), title: 'y two', padding: '.'.repeat(600) }], [])
  );
  assert.deepEqual(view(), { log_x: 'indexed:xray|xray', log_y: 'y two|yankee' });
});

test('a missing index: rows come from the files, and an index appearing or vanishing is followed', async (t) => {
  useDataDir('mixdog-reader-catalog-noindex-');
  replace('plain_e', 'echo');
  replace('plain_f', 'foxtrot');
  const parsed = { plain_e: '|echo', plain_f: '|foxtrot' };
  assert.deepEqual(view(), parsed);
  assert.deepEqual(listStoredSessionSummaries({ rebuildIfMissing: false }), []);
  await settle();
  list();
  const counts = spyFs(t);
  assert.deepEqual(view(), parsed);
  assert.equal(counts.sessionFileStats.size, 0);
  assert.equal(counts.reads + counts.readdirs, 0);

  writeBase([indexRow('plain_e', 'echo')]);
  assert.deepEqual(view(), { ...parsed, plain_e: 'indexed:echo|echo' });
  assert.deepEqual([...counts.sessionFileStats], [fileOf('plain_e')]);
  unlinkSync(indexPath());
  assert.deepEqual(view(), parsed);
  assertMatchesStorage();
});

test('index updates written by another process', (t) => {
  // Continues the settled data dir of the previous test.
  writeBase([]);
  list();
  const counts = spyFs(t);
  const otherProcess = (script) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  const row = indexRow('plain_f', 'renamed in the CLI');
  const append = (rows) =>
    otherProcess(
      `import { appendFileSync } from 'node:fs';
       appendFileSync(${JSON.stringify(logPath())}, ${JSON.stringify(encodeSummaryOps(rows, []))});`
    );
  append([row]);
  assert.equal(view().plain_f, 'indexed:renamed in the CLI|renamed in the CLI');
  assert.deepEqual([...counts.sessionFileStats], [fileOf('plain_f')]);

  // A compaction folds the log into a new base: same rows, nothing to reconcile.
  counts.sessionFileStats.clear();
  const tmp = `${indexPath()}.tmp`;
  otherProcess(
    `import { renameSync, writeFileSync } from 'node:fs';
     writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(JSON.stringify({ version: 2, rows: [row] }))});
     renameSync(${JSON.stringify(tmp)}, ${JSON.stringify(indexPath())});
     writeFileSync(${JSON.stringify(logPath())}, '');`
  );
  assert.equal(view().plain_f, 'indexed:renamed in the CLI|renamed in the CLI');
  assert.equal(counts.sessionFileStats.size, 0);

  // A row that does not describe the file on disk never replaces the file's.
  append([{ ...row, title: 'stale', storageSize: 1 }]);
  assert.equal(view().plain_f, '|foxtrot');
  assertMatchesStorage();
  // A malformed base is no index at all.
  writeFileSync(indexPath(), '{');
  assert.deepEqual(view(), { plain_e: '|echo', plain_f: '|foxtrot' });
});

test('without a base index, the store’s own saves still refresh their session', () => {
  useDataDir('mixdog-reader-catalog-logonly-');
  saveIndexed('indexed_l', 'first');
  assert.equal(view().indexed_l, '|first');
  saveIndexed('indexed_l', 'second');
  assert.equal(view().indexed_l, '|second', 'the log row marks the session changed');
  assertMatchesStorage();
});

test('a failed index read is retried on the next call, retained rows included', (t) => {
  useDataDir('mixdog-reader-catalog-index-eio-');
  replace('indexed_m', 'mike');
  writeBase([indexRow('indexed_m', 'mike')]);
  const failing = new Set();
  const failingReads = new Set();
  spyFs(t, failing, failingReads);
  assert.equal(view().indexed_m, 'indexed:mike|mike');
  // A compaction lands while the index cannot be read (EIO).
  failingReads.add(indexPath());
  writeBase([indexRow('indexed_m', 'mike')]);
  assert.equal(view().indexed_m, '|mike', 'no readable index: the file is parsed, as before');
  failingReads.clear();
  failing.add(fileOf('indexed_m'));
  const expected = { indexed_m: 'indexed:mike|mike' };
  assert.deepEqual(view(), expected, 'read again: the unreadable record keeps its index row');
  assert.deepEqual(view(listStoredSessionSummaries({ refreshFromStorage: true })), expected);
});
