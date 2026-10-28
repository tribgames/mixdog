import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionService } from './session-service.mjs';
import {
  readTranscriptHistory,
  readTranscriptRange,
  requestedTranscriptHistory,
} from './session-service/projection/transcript-window.mjs';
import { sessionReadOutput } from './session-tool-output.mjs';

const history = Array.from({ length: 8300 }, (_, i) => ({
  id: `hist_s_${i}_0`,
  kind: i % 2 ? 'turndone' : 'assistant',
  text: `row ${i}`,
  ...(i % 2 ? { status: 'failed' } : {}),
}));
const stored = async (_id, { transcriptItemLimit }) => ({
  items: history.slice(-transcriptItemLimit),
  transcriptHasOlder: history.length > transcriptItemLimit,
});

test('request-local ranges preserve cold/live history beyond UI window caps without changing attached views', async () => {
  const entry = { runtime: { getState: () => ({ items: history.slice(-10) }) }, transcriptView: { full: true } };
  for (const offset of [0, 20, 8200, 8300, 9000]) {
    const cold = await readTranscriptRange(null, 's', stored, { offset, limit: 5 });
    const live = await readTranscriptRange(entry, 's', stored, { offset, limit: 5 });
    assert.deepEqual(live, cold);
    const end = Math.max(0, history.length - offset);
    assert.deepEqual(cold.items, history.slice(Math.max(0, end - 5), end));
  }
  assert.deepEqual(entry.transcriptView, { full: true });
});

test('budget-cut backward pages traverse every item once', async () => {
  const rows = history.slice(-105).map((item) => ({ ...item, text: '😀"\\'.repeat(1500) }));
  const reader = async (_id, { transcriptItemLimit }) => ({
    items: rows.slice(-transcriptItemLimit),
    transcriptHasOlder: rows.length > transcriptItemLimit,
  });
  let offset = 0;
  const seen = [];
  do {
    const range = await readTranscriptRange(null, 's', reader, { offset, limit: 25 });
    const output = sessionReadOutput('s', range);
    seen.unshift(...output.items.map((item) => item.id));
    offset = output.nextOffset;
  } while (offset !== null);
  assert.deepEqual(
    seen,
    rows.map((item) => item.id)
  );
});

test('a legacy reader answering a fixed tail ends backward paging instead of repeating an empty page', async () => {
  const tail = history.slice(-1);
  const fixed = async () => ({ items: tail, transcriptHasOlder: true });
  const first = await readTranscriptRange(null, 's', fixed, { offset: 0, limit: 1 });
  assert.deepEqual(first.items, tail);
  const offset = sessionReadOutput('s', first).nextOffset;
  assert.equal(offset, 1);
  await assert.rejects(readTranscriptRange(null, 's', fixed, { offset, limit: 1 }), /not available/);
});

test('a deep range of a session held whole in runtime memory returns its rows past the shared-window cap', async () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `live_${i}`, kind: 'assistant', text: `live ${i}` }));
  const entry = { runtime: { getState: () => ({ items: rows }) }, transcriptView: { full: true } };
  const range = await readTranscriptRange(entry, 's', async () => null, { offset: 9_000, limit: 5 });
  assert.deepEqual(range.items, rows.slice(995, 1_000));
  assert.equal(range.hasOlder, true);
});

test('a historical-position read of a live session pages its runtime rows each way without moving its view', async () => {
  const rows = Array.from({ length: 3_000 }, (_, i) => ({ id: `live_${i}`, kind: 'assistant', text: `live ${i}` }));
  const view = { full: true };
  const entry = { runtime: { getState: () => ({ items: rows }) }, transcriptView: view };
  const older = await readTranscriptHistory(entry, 's', async () => null, { before: 'live_2000', limit: 512 });
  assert.deepEqual(
    older.items.map((row) => row.id),
    rows.slice(1488, 2000).map((row) => row.id)
  );
  assert.deepEqual([older.hasOlder, older.hasNewer], [true, true]);
  const newer = await readTranscriptHistory(entry, 's', async () => null, { after: 'live_2900', limit: 512 });
  assert.deepEqual(
    newer.items.map((row) => row.id),
    rows.slice(2901).map((row) => row.id)
  );
  assert.equal(newer.hasNewer, false);
  const first = await readTranscriptHistory(entry, 's', async () => null, { before: 'live_3', limit: 512 });
  assert.deepEqual([first.items.length, first.hasOlder], [3, false]);
  const gone = await readTranscriptHistory(entry, 's', async () => null, { before: 'nope', limit: 8 });
  assert.equal(gone.reset, true);
  assert.equal(entry.transcriptView, view, 'no view moved');
  assert.throws(() => requestedTranscriptHistory({ transcriptHistory: { before: 'a', limit: 513 } }), /invalid/);
  assert.throws(() => requestedTranscriptHistory({ transcriptHistory: { before: 'a', after: 'b', limit: 1 } }));
});

test('an unknown cursor on a live session over a large archive answers reset within a bounded lookup', async () => {
  const archiveRows = Array.from({ length: 70_000 }, (_, i) => ({
    id: `arch1_${i}`,
    kind: 'assistant',
    text: `a${i}`,
  }));
  let moved = 0;
  let largest = 0;
  const reader = async (_id, options) => {
    const range = options.compactionArchive;
    if (!range) return null;
    const end = archiveRows.length - range.skip;
    const start = Math.max(0, end - range.limit);
    moved += end - start;
    largest = Math.max(largest, range.limit);
    return { items: archiveRows.slice(start, end), hasOlder: start > 0 };
  };
  const runtime = [
    { id: 'divider', kind: 'statusdone', status: 'compacted' },
    { id: 'after_0', kind: 'assistant', text: 'live' },
  ];
  const entry = {
    runtime: { getState: () => ({ items: runtime, transcriptArchive: { after: 0, before: 2 } }) },
    transcriptView: { full: true },
  };
  const answer = await readTranscriptHistory(entry, 's', reader, { before: 'not_a_row', limit: 8 });
  assert.equal(answer.reset, true);
  assert.ok(largest <= 8_192, `${largest} rows asked in one read`);
  // Doubling passes up to the bound: about twice it, whatever the archive's depth.
  assert.ok(moved <= 3 * 8_192, `${moved} rows moved of ${archiveRows.length}`);
});

test('a live session compacted while running pages its archive by position to the first row and back', async () => {
  const archiveRows = Array.from({ length: 20_000 }, (_, i) => ({
    id: `arch1_${i}`,
    kind: 'assistant',
    text: `a${i}`,
  }));
  let largest = 0;
  const reader = async (_id, options) => {
    const range = options.compactionArchive;
    if (!range) return null;
    largest = Math.max(largest, range.limit);
    const end = archiveRows.length - range.skip;
    const start = Math.max(0, end - range.limit);
    return { items: archiveRows.slice(start, end), hasOlder: start > 0 };
  };
  const runtime = [
    { id: 'divider', kind: 'statusdone', status: 'compacted' },
    { id: 'after_0', kind: 'assistant', text: 'live' },
  ];
  const entry = {
    runtime: { getState: () => ({ items: runtime, transcriptArchive: { after: 0, before: 2 } }) },
    transcriptView: { full: true },
  };
  let boundary = runtime[0].id;
  let position;
  let rows = [];
  for (let pages = 0; ; pages += 1) {
    const page = await readTranscriptHistory(entry, 's', reader, {
      before: boundary,
      limit: 512,
      ...(position ? { position } : {}),
    });
    assert.ok(!page.reset && page.items.length > 0 && pages < 100, `page ${pages}`);
    rows = page.items.concat(rows);
    if (!page.hasOlder) break;
    boundary = page.items[0].id;
    position = page.positions[0];
  }
  assert.deepEqual(
    rows.map((row) => row.id),
    archiveRows.map((row) => row.id)
  );
  assert.ok(largest <= 512, `${largest} archive rows in one read`);
  // And back down from the first row, into the runtime's rows.
  let after = { id: rows[0].id, position: 'a:0:2:19999' };
  let seen = 0;
  for (;;) {
    const page = await readTranscriptHistory(entry, 's', reader, {
      after: after.id,
      limit: 512,
      position: after.position,
    });
    seen += page.items.length;
    if (!page.hasNewer) break;
    after = { id: page.items.at(-1).id, position: page.positions?.at(-1) };
  }
  assert.equal(seen, archiveRows.length - 1 + runtime.length);
});

test('paging from the archive into a spill whose first page is unreadable answers reset, never skipping rows', async () => {
  const archiveRows = Array.from({ length: 10 }, (_, i) => ({ id: `arch1_${i}`, kind: 'assistant', text: `a${i}` }));
  const reader = async (_id, options) => {
    const range = options.compactionArchive;
    if (!range) return null;
    const end = archiveRows.length - range.skip;
    const start = Math.max(0, end - range.limit);
    return { items: archiveRows.slice(start, end), hasOlder: start > 0 };
  };
  const runtime = [{ id: 'live_0', kind: 'assistant', text: 'live' }];
  const entry = {
    runtime: {
      getState: () => ({
        items: runtime,
        transcriptArchive: { after: 0, before: 2 },
        transcriptSpilled: { rows: 100, epoch: 3 },
      }),
      // The spill's pages are gone: every read is broken.
      readSpilledTranscript: () => ({ items: [], start: 0, broken: true }),
    },
    transcriptView: { full: true },
  };
  const page = await readTranscriptHistory(entry, 's', reader, { after: 'arch1_9', limit: 512, position: 'a:0:2:0' });
  assert.equal(page.reset, true, 'the 100 spilled rows are not skipped');
  assert.deepEqual(page.items, []);
});

test('a historical-position read of a cold session goes to the store by row id, and a reader without it resets', async () => {
  const seen = [];
  const reader = async (_id, options) => {
    seen.push(options.transcriptCursor);
    return { items: history.slice(10, 20), transcriptHasOlder: true, transcriptHasNewer: true };
  };
  const page = await readTranscriptHistory(null, 's', reader, { before: 'hist_s_20_0', limit: 10, byteBudget: 500 });
  assert.deepEqual(seen, [{ before: 'hist_s_20_0', maxRows: 10, byteBudget: 500 }]);
  assert.deepEqual([page.items.length, page.hasOlder, page.hasNewer], [10, true, true]);
  const legacy = await readTranscriptHistory(null, 's', stored, { before: 'hist_s_20_0', limit: 10 });
  assert.equal(legacy.reset, true);
});

test('service range reads preserve failure rows and avoid runtime creation', async () => {
  const service = createSessionService({
    createSessionRuntime: async () => assert.fail('read must not create a runtime'),
    sessionExists: async () => true,
    readStoredSession: stored,
  });
  try {
    const result = await service.readSession({ sessionId: 's', transcriptRange: { offset: 1, limit: 3 } });
    assert.deepEqual(result.range.items, history.slice(-4, -1));
    await assert.rejects(service.readSession({ sessionId: 's', transcriptRange: { offset: -1, limit: 1 } }), /invalid/);
  } finally {
    await service.stop('test complete');
  }
});
