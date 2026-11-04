import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  _sessionSummary,
  _upsertSessionSummaryRow,
  _writeSummaryIndex,
  compactSummaryIndex,
  settleSummaryIndexWrites,
  summaryIndexPath,
} from './store-summary-index.mjs';
import { summaryLogPath } from './store-summary-log.mjs';
import { createOrdinaryCatalog } from './store-summary-catalog.mjs';

// A compaction writes the new base and then empties the log, with no lock a
// reader takes. A reader that read the log before the compaction and the base
// after it must not lay the old log over the newer base.

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

async function withDataDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-summary-race-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'), { recursive: true });
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Runs `afterLog()` once the reader has read the delta log and before it reads on. */
function afterNextLogRead(t, afterLog, { every = false } = {}) {
  const readFile = fsp.readFile;
  let hit = false;
  let inside = false; // the writer's own reads of the log are not the reader's
  t.mock.method(fsp, 'readFile', async (...args) => {
    const result = await readFile.apply(fsp, args);
    if (!inside && (every || !hit) && String(args[0]) === summaryLogPath(summaryIndexPath())) {
      hit = true;
      inside = true;
      try {
        await afterLog();
      } finally {
        inside = false;
      }
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => hit;
}

test('a compaction between the log read and the base read never lays an old log row over the newer base', (t) =>
  withDataDir(async () => {
    await _writeSummaryIndex(Array.from({ length: 10 }, (_, i) => summaryRow(`s${i}`, 1_000 + i, `hello ${i}`)));
    _upsertSessionSummaryRow(summaryRow('s5', 9_000, 'first version'));
    await settleSummaryIndexWrites();
    const catalog = createOrdinaryCatalog();

    const raced = afterNextLogRead(t, async () => {
      _upsertSessionSummaryRow(summaryRow('s5', 10_000, 'second version'));
      await settleSummaryIndexWrites();
      assert.equal(await compactSummaryIndex(), true);
    });
    const index = await catalog.loadIndexAsync();

    assert.equal(raced(), true, 'the compaction ran inside the read');
    assert.equal(index.rowsById.get('s5')?.updatedAt, 10_000, 'the committed row, not the older log row');
  }));

test('a read replaced twice in a row is no read: the index counts as unreadable, never a mixed pair', (t) =>
  withDataDir(async () => {
    await _writeSummaryIndex(Array.from({ length: 10 }, (_, i) => summaryRow(`s${i}`, 1_000 + i, `hello ${i}`)));
    _upsertSessionSummaryRow(summaryRow('s5', 9_000, 'first version')); // the log exists
    await settleSummaryIndexWrites();
    const catalog = createOrdinaryCatalog();
    let version = 9_000;
    afterNextLogRead(
      t,
      async () => {
        version += 1_000;
        _upsertSessionSummaryRow(summaryRow('s5', version, `version ${version}`));
        await settleSummaryIndexWrites();
        assert.equal(await compactSummaryIndex(), true);
      },
      { every: true }
    );
    const index = await catalog.loadIndexAsync();
    assert.equal(index.rows, null, 'no rows are claimed; the session files are the authority');
    t.mock.restoreAll();
    syncBuiltinESMExports();
    // The next read, with no compaction inside it, is whole again.
    assert.equal((await catalog.loadIndexAsync()).rowsById.get('s5')?.updatedAt, version);
  }));
test('a warm catalog extended by new log lines is checked against a compaction too', (t) =>
  withDataDir(async () => {
    await _writeSummaryIndex(Array.from({ length: 10 }, (_, i) => summaryRow(`s${i}`, 1_000 + i, `hello ${i}`)));
    _upsertSessionSummaryRow(summaryRow('s5', 9_000, 'first version'));
    await settleSummaryIndexWrites();
    const catalog = createOrdinaryCatalog();
    assert.equal((await catalog.loadIndexAsync()).rowsById.get('s5')?.updatedAt, 9_000, 'warm');
    // A line lands after the warm read: the next read extends the cached rows by it.
    _upsertSessionSummaryRow(summaryRow('s6', 9_500, 'another session'));
    await settleSummaryIndexWrites();

    const raced = afterNextLogRead(t, async () => {
      _upsertSessionSummaryRow(summaryRow('s5', 10_000, 'second version'));
      await settleSummaryIndexWrites();
      assert.equal(await compactSummaryIndex(), true);
    });
    const index = await catalog.loadIndexAsync();

    assert.equal(raced(), true, 'the compaction ran inside the warm read');
    assert.equal(index.rowsById.get('s5')?.updatedAt, 10_000, 'the committed row');
    assert.equal(index.rowsById.get('s6')?.updatedAt, 9_500);
  }));
test('a retry after a compaction does not extend the rows of the replaced base', (t) =>
  withDataDir(async () => {
    await _writeSummaryIndex(Array.from({ length: 10 }, (_, i) => summaryRow(`s${i}`, 1_000 + i, `hello ${i}`)));
    const catalog = createOrdinaryCatalog();
    assert.equal((await catalog.loadIndexAsync()).rowsById.get('s5')?.updatedAt, 1_005, 'warm, with no log yet');
    _upsertSessionSummaryRow(summaryRow('s5', 9_000, 'first version'));
    await settleSummaryIndexWrites();

    const raced = afterNextLogRead(t, async () => {
      _upsertSessionSummaryRow(summaryRow('s5', 10_000, 'second version'));
      await settleSummaryIndexWrites();
      assert.equal(await compactSummaryIndex(), true);
    });
    const index = await catalog.loadIndexAsync();

    assert.equal(raced(), true, 'the compaction ran inside the read');
    assert.equal(
      index.rowsById.get('s5')?.updatedAt,
      10_000,
      'the committed row, not the cached base plus a truncated log'
    );
  }));
