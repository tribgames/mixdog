import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendHistoryPage,
  prependHistoryPage,
  TRANSCRIPT_WINDOW_MAX_CHARS,
  TRANSCRIPT_WINDOW_MAX_ITEMS,
  TranscriptHistoryPager,
} from './transcript-history.ts';

/** A daemon's historical-position reads over `rows` (oldest first). */
function historyHost(rows, pageRows = Number.POSITIVE_INFINITY) {
  const reads = [];
  const read = async (_sessionId, request) => {
    reads.push(request);
    const older = request.before !== undefined;
    const limit = Math.min(request.limit, pageRows);
    const at = rows.findIndex((row) => row.id === (older ? request.before : request.after));
    if (at < 0) return { items: [], hasOlder: false, hasNewer: false, reset: true };
    if (older) {
      const start = Math.max(0, at - limit);
      return { items: rows.slice(start, at), hasOlder: start > 0, hasNewer: true };
    }
    const end = Math.min(rows.length, at + 1 + limit);
    return { items: rows.slice(at + 1, end), hasOlder: true, hasNewer: end < rows.length };
  };
  return { read, reads };
}

test('scrolling a 70,000-row session to its first row and back keeps the window within its item bound', async () => {
  const rows = Array.from({ length: 70_000 }, (_, i) => ({ id: `row_${i}`, kind: 'assistant', text: `r${i}` }));
  const live = { items: rows.slice(-64), hasOlder: true };
  const { read, reads } = historyHost(rows);
  let changes = 0;
  const pager = new TranscriptHistoryPager(
    's',
    () => read,
    () => live,
    () => (changes += 1)
  );
  let maxItems = live.items.length;
  while ((pager.window ?? live).hasOlder) {
    assert.equal(await pager.earlier(), 'paged');
    maxItems = Math.max(maxItems, pager.window.items.length);
  }
  assert.equal(pager.window.items[0].id, 'row_0', 'the first row is reached');
  assert.ok(maxItems <= TRANSCRIPT_WINDOW_MAX_ITEMS, `${maxItems} items held`);
  assert.equal(pager.window.hasNewer, true, 'the newest rows were evicted');
  assert.ok(reads.every((request) => request.limit <= 512));
  // Back down: newer rows page in from the window's bottom, the oldest go.
  while (pager.window?.hasNewer) {
    await pager.atBottom();
    maxItems = Math.max(maxItems, pager.window.items.length);
  }
  assert.ok(maxItems <= TRANSCRIPT_WINDOW_MAX_ITEMS);
  assert.equal(pager.window.items.at(-1).id, 'row_69999');
  // At the bottom with nothing held back: the live tail takes over again.
  await pager.atBottom();
  assert.equal(pager.window, null);
  assert.ok(changes > 0);
});

test('a landed page keeps the rows beside it and the window stays within its character bound', () => {
  const big = (i) => ({ id: `b${i}`, text: 'y'.repeat(200_000) });
  const window = { items: Array.from({ length: 100 }, (_, i) => big(100 + i)), hasOlder: true, hasNewer: false };
  // A page within a 1 MB budget: five such rows.
  const page = Array.from({ length: 5 }, (_, i) => big(i));
  const next = prependHistoryPage(window, page, true);
  const chars = next.items.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  assert.equal(next.items[0].id, 'b0');
  assert.equal(next.items[5].id, 'b100', 'the rows beside the page stay');
  assert.ok(chars <= TRANSCRIPT_WINDOW_MAX_CHARS, `${chars} chars`);
  assert.equal(next.hasNewer, true);
  const appended = appendHistoryPage({ items: window.items, hasOlder: false, hasNewer: true }, page, false);
  const appendedChars = appended.items.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  assert.equal(appended.items.at(-1).id, 'b4');
  assert.ok(appendedChars <= TRANSCRIPT_WINDOW_MAX_CHARS);
  assert.equal(appended.hasOlder, true);
});

test('the character bound holds even when the page and its neighbours alone exceed it', () => {
  const row = (id) => ({ id, text: 'q'.repeat(3_000_000) });
  const total = (items) => items.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  const window = { items: Array.from({ length: 40 }, (_, i) => row(`w${i}`)), hasOlder: true, hasNewer: false };
  const page = Array.from({ length: 8 }, (_, i) => row(`p${i}`));
  const up = prependHistoryPage(window, page, false);
  assert.ok(total(up.items) <= TRANSCRIPT_WINDOW_MAX_CHARS, `${total(up.items)} chars`);
  // Kept around the reader: the row below the page and the page rows nearest it.
  assert.equal(up.items.at(-1).id, 'w0');
  assert.equal(up.items.at(-2).id, 'p7');
  assert.deepEqual([up.hasOlder, up.hasNewer], [true, true]);
  const down = appendHistoryPage(window, page, false);
  assert.ok(total(down.items) <= TRANSCRIPT_WINDOW_MAX_CHARS);
  assert.equal(down.items[0].id, 'w39');
  assert.equal(down.items[1].id, 'p0');
  assert.deepEqual([down.hasOlder, down.hasNewer], [true, true]);
});

test('a row larger than the whole bound never traps paging in either direction', async () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    i === 50 ? { id: 'r50', text: 'z'.repeat(TRANSCRIPT_WINDOW_MAX_CHARS + 1) } : { id: `r${i}`, text: `r${i}` }
  );
  const live = { items: rows.slice(50, 56), hasOlder: true };
  const { read } = historyHost(rows, 5);
  const pager = new TranscriptHistoryPager(
    's',
    () => read,
    () => live,
    () => {}
  );
  const total = (items) => items.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  for (let pages = 0; (pager.window ?? live).hasOlder; pages += 1) {
    assert.ok(pages < 50, 'older pages advance');
    assert.equal(await pager.earlier(), 'paged');
    const items = pager.window.items;
    assert.ok(items.length === 1 || total(items) <= TRANSCRIPT_WINDOW_MAX_CHARS);
  }
  assert.equal(pager.window.items[0].id, 'r0', 'the first row is reached past the oversized one');
  for (let pages = 0; pager.window?.hasNewer; pages += 1) {
    assert.ok(pages < 50, 'newer pages advance');
    assert.equal(await pager.later(), 'paged');
    const items = pager.window.items;
    assert.ok(items.length === 1 || total(items) <= TRANSCRIPT_WINDOW_MAX_CHARS, 'only a lone oversized row exceeds');
  }
  assert.equal(pager.window.items.at(-1).id, 'r99', 'and the newest, past it again');
});

test('a page still on its way when the reader jumps to the latest reply is dropped', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }));
  const live = { items: rows.slice(-10), hasOlder: true };
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { read } = historyHost(rows);
  const pager = new TranscriptHistoryPager(
    's',
    () =>
      async (...args) => {
        await gate;
        return read(...args);
      },
    () => live,
    () => {}
  );
  const pending = pager.earlier();
  pager.toLive();
  release();
  assert.equal(await pending, 'idle');
  assert.equal(pager.window, null, 'the late page did not recreate the window');
  assert.equal(await pager.earlier(), 'paged', 'paging resumes afterwards');
});

test('a read rejected while a window is held returns to the live tail, where window growth takes over', async () => {
  const rows = Array.from({ length: 2_000 }, (_, i) => ({ id: `r${i}` }));
  const live = { items: rows.slice(-10), hasOlder: true };
  const { read } = historyHost(rows);
  let fail = false;
  const pager = new TranscriptHistoryPager(
    's',
    () =>
      async (...args) => {
        if (fail) throw new Error('relay dropped');
        return read(...args);
      },
    () => live,
    () => {}
  );
  assert.equal(await pager.earlier(), 'paged');
  assert.ok(pager.window);
  fail = true;
  assert.equal(await pager.earlier(), 'unsupported');
  assert.equal(pager.window, null, 'not stranded in a window that can no longer page');
  // The hook grows the live window on 'unsupported' with no window held.
  assert.equal(await pager.earlier(), 'unsupported');
  assert.equal(await pager.later(), 'idle');
});

test('a host without positional reads, or a vanished boundary row, never strands the reader', async () => {
  const live = { items: [{ id: 'a' }, { id: 'b' }], hasOlder: true };
  const without = new TranscriptHistoryPager(
    's',
    () => undefined,
    () => live,
    () => {}
  );
  assert.equal(await without.earlier(), 'unsupported');
  const rejecting = new TranscriptHistoryPager(
    's',
    () => async () => {
      throw new Error('unknown method');
    },
    () => live,
    () => {}
  );
  assert.equal(await rejecting.earlier(), 'unsupported');
  const old = new TranscriptHistoryPager(
    's',
    () => async () => ({ items: [], hasOlder: false, hasNewer: false, unsupported: true }),
    () => live,
    () => {}
  );
  assert.equal(await old.earlier(), 'unsupported');
  const { read } = historyHost([{ id: 'x' }, { id: 'a' }, { id: 'b' }]);
  const pager = new TranscriptHistoryPager(
    's',
    () => read,
    () => live,
    () => {}
  );
  assert.equal(await pager.earlier(), 'paged');
  assert.deepEqual(
    pager.window.items.map((item) => item.id),
    ['x', 'a', 'b']
  );
  // Compaction removed the row: back to the live tail.
  const gone = new TranscriptHistoryPager(
    's',
    () => historyHost([]).read,
    () => live,
    () => {}
  );
  assert.equal(await gone.earlier(), 'idle');
  assert.equal(gone.window, null);
});
