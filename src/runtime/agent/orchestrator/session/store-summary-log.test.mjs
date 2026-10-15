import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  _flushPendingSummaryOps,
  _removeSessionSummary,
  _sessionSummary,
  _upsertSessionSummaryRow,
  _writeSummaryIndex,
  compactSummaryIndex,
  settleSummaryIndexWrites,
  summaryIndexPath,
  summaryLockFailureStats,
  sweepStaleSummaryTempFiles,
} from './store-summary-index.mjs';
import { summaryLogPath } from './store-summary-log.mjs';
import { listStoredSessionSummaries } from './store-summary-reader.mjs';

// The summary index is `session-summaries.json` (compacted base) plus
// `session-summaries.log` (per-session delta lines). A session update appends
// one line; readers replay the log over the base.

function summaryRow(id, updatedAt, text) {
  return _sessionSummary({
    id,
    updatedAt,
    createdAt: updatedAt,
    messages: [
      { role: 'user', content: text },
      { role: 'assistant', content: 'ok' },
    ],
  });
}

function baseRows(count = 200) {
  return Array.from({ length: count }, (_, i) => summaryRow(`s${i}`, 1_000 + i, `hello ${i}`));
}

function withDataDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-log-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'), { recursive: true });
  const restore = () => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  };
  return Promise.resolve(fn(root)).finally(restore);
}

const readCatalog = () => listStoredSessionSummaries({ rebuildIfMissing: false });

test('an update appends to the delta log and never rewrites the base; readers see it', () =>
  withDataDir(async () => {
    _writeSummaryIndex(baseRows());
    const indexPath = summaryIndexPath();
    const baseBefore = readFileSync(indexPath);
    assert.equal(existsSync(summaryLogPath(indexPath)), false, 'legacy layout: base only');

    _upsertSessionSummaryRow(summaryRow('s5', 9_999, 'changed five'));
    _upsertSessionSummaryRow(summaryRow('fresh', 8_000, 'brand new'));
    _removeSessionSummary('s6');
    await settleSummaryIndexWrites();

    assert.deepEqual(readFileSync(indexPath), baseBefore, 'base file bytes are untouched');
    const lines = readFileSync(summaryLogPath(indexPath), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'two upserts + one removal batch');

    const rows = readCatalog();
    assert.equal(rows.length, 200 + 1 - 1);
    assert.equal(rows.find((row) => row.id === 's5').preview, 'changed five');
    assert.equal(rows.find((row) => row.id === 'fresh').preview, 'brand new');
    assert.equal(
      rows.some((row) => row.id === 's6'),
      false
    );
  }));

test('base + log reads identically to a full rewrite of the same rows', async () => {
  const ops = () => {
    _upsertSessionSummaryRow(summaryRow('s5', 9_999, 'changed five'));
    _upsertSessionSummaryRow(summaryRow('fresh', 8_000, 'brand new'));
    _removeSessionSummary('s6');
  };
  let viaLog;
  await withDataDir(async () => {
    _writeSummaryIndex(baseRows());
    ops();
    await settleSummaryIndexWrites();
    viaLog = readCatalog();
  });
  let viaRewrite;
  await withDataDir(async () => {
    const rows = baseRows().filter((row) => row.id !== 's6' && row.id !== 's5');
    rows.push(summaryRow('s5', 9_999, 'changed five'), summaryRow('fresh', 8_000, 'brand new'));
    _writeSummaryIndex(rows);
    viaRewrite = readCatalog();
  });
  assert.deepEqual(viaLog, viaRewrite);
});

test('compaction folds the log into the base; a crash before the log is emptied replays harmlessly', () =>
  withDataDir(async () => {
    _writeSummaryIndex(baseRows());
    _upsertSessionSummaryRow(summaryRow('s5', 9_999, 'changed five'));
    _removeSessionSummary('s6');
    await settleSummaryIndexWrites();
    const indexPath = summaryIndexPath();
    const logPath = summaryLogPath(indexPath);
    const logText = readFileSync(logPath, 'utf8');
    const before = readCatalog();

    assert.equal(await compactSummaryIndex(), true);
    assert.equal(readFileSync(logPath, 'utf8'), '', 'log emptied');
    assert.deepEqual(readCatalog(), before);
    const base = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.equal(
      base.rows.some((row) => row.id === 's6'),
      false,
      'removal folded into the base'
    );

    // Crash between "base written" and "log emptied": the folded ops are still
    // in the log. Replay is last-writer-wins per id, so nothing changes.
    writeFileSync(logPath, logText);
    assert.deepEqual(readCatalog(), before);
    // Later ops layered on top of the stale log still win.
    _upsertSessionSummaryRow(summaryRow('s5', 12_000, 'newer five'));
    await settleSummaryIndexWrites();
    assert.equal(readCatalog().find((row) => row.id === 's5').preview, 'newer five');
  }));

test('a torn log tail is skipped and cannot corrupt the next append', () =>
  withDataDir(async () => {
    _writeSummaryIndex(baseRows(20));
    const logPath = summaryLogPath(summaryIndexPath());
    appendFileSync(logPath, '{"u":{"id":"broken","preview":"tor');
    assert.equal(readCatalog().length, 20);

    _upsertSessionSummaryRow(summaryRow('after', 5_000, 'after the tear'));
    await settleSummaryIndexWrites();
    const rows = readCatalog();
    assert.equal(rows.length, 21);
    assert.equal(rows.find((row) => row.id === 'after').preview, 'after the tear');
  }));

test('the exit-drain path appends synchronously', () =>
  withDataDir(async () => {
    _writeSummaryIndex(baseRows(5));
    _upsertSessionSummaryRow(summaryRow('exit', 7_000, 'written at exit'));
    _flushPendingSummaryOps({ sync: true });
    assert.equal(readCatalog().find((row) => row.id === 'exit')?.preview, 'written at exit');
    await settleSummaryIndexWrites();
  }));

test('try-lock failures are counted and reported at most once per interval, then retried', (t) =>
  withDataDir(async () => {
    _writeSummaryIndex(baseRows(3));
    const lockPath = `${summaryIndexPath()}.lock`;
    const messages = [];
    const write = process.stderr.write.bind(process.stderr);
    t.mock.method(process.stderr, 'write', (chunk, ...rest) => {
      if (String(chunk).startsWith('[session-summaries]')) messages.push(String(chunk));
      else write(chunk, ...rest);
      return true;
    });
    // A live foreign owner: the try-lock is refused.
    writeFileSync(lockPath, `${process.pid} ${Date.now()} foreign-token\n`);
    const before = summaryLockFailureStats().total;

    _upsertSessionSummaryRow(summaryRow('a', 6_000, 'first'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    _upsertSessionSummaryRow(summaryRow('b', 6_001, 'second'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(
      summaryLockFailureStats().total,
      before + 1,
      'the refused try-lock is counted; later saves join the retry'
    );
    assert.equal(messages.length, 1, 'reported once inside the rate-limit window');
    assert.match(messages[0], /try-lock failure/);
    assert.equal(
      readCatalog().some((row) => row.id === 'a'),
      false,
      'nothing landed while the lock was held'
    );

    unlinkSync(lockPath);
    await settleSummaryIndexWrites(); // the queued retry lands both rows
    const ids = readCatalog().map((row) => row.id);
    assert.ok(ids.includes('a') && ids.includes('b'));
  }));

test('the startup sweep removes only this store’s stale temp files and skips a locked index', () =>
  withDataDir(async (root) => {
    const hex = (c) => c.repeat(24);
    const tmp = (name) => join(root, name);
    const stale = tmp(`.session-summaries.json.${hex('a')}.tmp`);
    const fresh = tmp(`.session-summaries.json.${hex('b')}.tmp`);
    const foreign = tmp(`.other-file.json.${hex('c')}.tmp`);
    const lookalike = tmp('.session-summaries.json.notahexname.tmp');
    for (const file of [stale, fresh, foreign, lookalike]) writeFileSync(file, 'x');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const file of [stale, foreign, lookalike]) utimesSync(file, old, old);

    // A held lock means a live writer may own a temp file: sweep nothing.
    const lockPath = `${summaryIndexPath()}.lock`;
    writeFileSync(lockPath, `${process.pid} ${Date.now()} foreign-token\n`);
    await assert.rejects(sweepStaleSummaryTempFiles(), { code: 'ELOCKCONTENDED' });
    assert.equal(existsSync(stale), true);
    unlinkSync(lockPath);

    // The first flush of the process sweeps.
    _upsertSessionSummaryRow(summaryRow('x', 4_000, 'trigger'));
    await settleSummaryIndexWrites();
    assert.equal(existsSync(stale), false, 'stale temp of this store removed');
    assert.equal(existsSync(fresh), true, 'a young temp may belong to a live writer');
    assert.equal(existsSync(foreign), true, 'another file’s temp is never touched');
    assert.equal(existsSync(lookalike), true, 'only the exact temp-name pattern matches');
  }));

test('one-shot exec sessions stay out of the cold catalog', () =>
  withDataDir(() => {
    const lead = { owner: 'cli', agent: 'lead', sourceType: 'lead' };
    _writeSummaryIndex([
      { ...summaryRow('leadrow', 2_000, 'keep me'), ...lead },
      { ...summaryRow('execrow', 3_000, 'hide me'), ...lead, sourceType: 'exec' },
    ]);
    assert.deepEqual(
      readCatalog().map((row) => row.id),
      ['leadrow']
    );
  }));
