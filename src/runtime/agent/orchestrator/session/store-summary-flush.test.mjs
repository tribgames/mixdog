import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  _flushPendingSummaryOps,
  _hasUnsettledSummaryOps,
  _removeSessionSummary,
  _sessionSummary,
  _upsertSessionSummaryRow,
  _writeSummaryIndex,
  settleSummaryIndexWrites,
  summaryIndexPath,
  summaryLockFailureStats,
} from './store-summary-index.mjs';
import { listStoredSessionSummaries } from './store-summary-reader.mjs';

const row = (id, updatedAt, text) =>
  _sessionSummary({
    id,
    updatedAt,
    createdAt: updatedAt,
    messages: [
      { role: 'user', content: text },
      { role: 'assistant', content: 'ok' },
    ],
  });

function withDataDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-flush-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'), { recursive: true });
  return Promise.resolve(fn(root)).finally(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

const catalog = () => listStoredSessionSummaries({ rebuildIfMissing: false });
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('many concurrent saves never overlap flushes and the latest op per session wins', () =>
  withDataDir(async () => {
    _writeSummaryIndex([row('keep', 1, 'k')]);
    const before = summaryLockFailureStats().total;
    for (let i = 0; i < 100; i++) {
      _upsertSessionSummaryRow(row(`s${i % 10}`, 100 + i, `v${i}`));
      if (i % 25 === 0) await tick(0); // spread saves across flushes
    }
    _removeSessionSummary('s3');
    await settleSummaryIndexWrites();
    assert.equal(summaryLockFailureStats().total, before, 'overlapping flushes would have refused each other');
    const rows = catalog();
    assert.equal(
      rows.some((r) => r.id === 's3'),
      false,
      'later removal wins'
    );
    assert.equal(rows.find((r) => r.id === 's9')?.updatedAt, 199, 'latest upsert wins');
  }));

test('a direct flush while one is in flight leaves ops pending for a follow-up', () =>
  withDataDir(async () => {
    _writeSummaryIndex([]);
    const before = summaryLockFailureStats().total;
    _upsertSessionSummaryRow(row('a', 10, 'a'));
    await tick(0);
    _upsertSessionSummaryRow(row('b', 11, 'b'));
    _flushPendingSummaryOps();
    _flushPendingSummaryOps();
    assert.equal(_hasUnsettledSummaryOps(), true);
    await settleSummaryIndexWrites();
    assert.equal(summaryLockFailureStats().total, before);
    const ids = catalog().map((r) => r.id);
    assert.ok(ids.includes('a') && ids.includes('b'));
  }));

test('saves during a scheduled retry wait for it; settle resolves only after persistence', () =>
  withDataDir(async () => {
    _writeSummaryIndex([]);
    const lockPath = `${summaryIndexPath()}.lock`;
    writeFileSync(lockPath, `${process.pid} ${Date.now()} foreign-token\n`);
    const before = summaryLockFailureStats().total;
    _upsertSessionSummaryRow(row('a', 20, 'a'));
    await tick(50);
    for (let i = 0; i < 20; i++) _upsertSessionSummaryRow(row(`b${i}`, 30 + i, 'b'));
    _upsertSessionSummaryRow(row('a', 25, 'a2')); // newer op for a requeued id
    await tick(50);
    assert.equal(summaryLockFailureStats().total, before + 1, 'no extra flush while the retry is scheduled');
    assert.equal(catalog().length, 0);
    let settled = false;
    const waiter = settleSummaryIndexWrites().then(() => {
      settled = true;
    });
    await tick(20);
    assert.equal(settled, false);
    unlinkSync(lockPath);
    await waiter;
    const rows = catalog();
    assert.equal(rows.length, 21);
    assert.equal(rows.find((r) => r.id === 'a')?.updatedAt, 25);
    assert.equal(summaryLockFailureStats().total, before + 1);
  }));

test('settles sharing one long-lived signal leave no abort listener behind once they land', () =>
  withDataDir(async () => {
    _writeSummaryIndex([]);
    const lifetime = new AbortController();
    for (let i = 0; i < 5; i++) {
      _upsertSessionSummaryRow(row(`r${i}`, 40 + i, 'r'));
      assert.equal(await settleSummaryIndexWrites({ ids: [`r${i}`], signal: lifetime.signal }), true);
    }
    assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
    assert.equal(catalog().length, 5);
  }));
