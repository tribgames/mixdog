// A live view pages past the runtime's in-memory rows into the rows the
// runtime spilled out of memory (TRANSCRIPT_LIVE_ITEM_CAP), exactly as they
// were spilled, and from there into durable history; a runtime that spilled
// nothing pages as before.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { archiveItemsForCompaction } from '../tui/session/compaction-view.mjs';
import { createSessionDraftStore } from '../tui/session/draft-store.mjs';
import { createTranscriptSpillBuffer } from '../tui/session/transcript-spill.mjs';
import { createTranscriptStore } from '../tui/session/transcript-store.mjs';
import {
  loadLiveTranscriptHead,
  readTranscriptRange,
  requestLiveTranscriptWindow,
  windowTranscriptSnapshot,
} from './session-service/projection/transcript-window.mjs';

/** A spill worker that writes each page at once, so pages are read from disk. */
function writingWorker() {
  const handlers = {};
  return {
    on(event, handler) {
      handlers[event] = handler;
    },
    postMessage({ id, targetPath, items }) {
      writeFileSync(targetPath, JSON.stringify(items));
      queueMicrotask(() => handlers.message?.({ id, ok: true }));
    },
    terminate() {},
    unref() {},
  };
}

const row = (n) => ({ id: `it_${n}`, kind: n % 2 ? 'assistant' : 'user', text: `row ${n} ${'x'.repeat(200)}` });
const ids = (wire) => wire.items.map((item) => item.id);

/** A live runtime of 700 rows with a live compaction after row 400, under the
 *  real memory cap; `all` is every row it ever showed, in order. */
async function compactedSpilledRuntime(t) {
  const spill = createTranscriptSpillBuffer({ workerFactory: writingWorker });
  t.after(() => spill.dispose());
  let all = [];
  let items = [];
  const push = (item) => {
    all = [...all, item];
    items = spill.capLive([...items, item]);
  };
  for (let n = 0; n < 400; n += 1) push(row(n));
  const divider = { id: 'it_div', at: 1 };
  all = archiveItemsForCompaction(all, divider).items;
  items = spill.capLive(archiveItemsForCompaction(items, divider).items);
  for (let n = 400; n < 700; n += 1) push(row(n));
  // Every page write has landed: the pages are read back from their files.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spill.pendingWriteCount, 0);
  const state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: spill.spilled };
  return { spill, state, all };
}

/** Pages a live view from a 32-row tail, one 64-row page at a time within the
 *  1 MB page budget, until nothing older is left; returns the last wire. */
async function pageToTop(entry, state, readStoredSession = async () => null) {
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: 1_000_000, pageBase: 0 });
  let wire = windowTranscriptSnapshot(entry, state);
  for (let step = 0; wire.transcriptHasOlder && step < 100; step += 1) {
    requestLiveTranscriptWindow(entry, {
      limit: wire.items.length + 64,
      byteBudget: 1_000_000,
      pageBase: wire.items.length,
    });
    await loadLiveTranscriptHead(entry, state.sessionId, readStoredSession);
    wire = windowTranscriptSnapshot(entry, state);
  }
  return wire;
}

const liveEntry = (state, readSpilledTranscript) => ({
  runtime: { getState: () => state, readSpilledTranscript },
  transcriptView: null,
  publishedSnapshot: null,
});

test('a compacted live runtime pages back through its spilled rows to its first row, exactly as spilled', async (t) => {
  const { spill, state, all } = await compactedSpilledRuntime(t);
  assert.equal(state.items[0].id, 'it_256', 'rows above it were spilled');
  assert.equal(state.transcriptSpilled.rows, 256);
  const entry = liveEntry(state, (range) => spill.readSpilled(range));
  const wire = await pageToTop(entry, state);
  assert.deepEqual(
    ids(wire),
    all.map((item) => item.id)
  );
  assert.deepEqual(wire.items, all, 'every row as it was spilled');
  assert.equal(wire.items[0].id, 'it_0');
  assert.equal(wire.transcriptHasOlder, false);
});

test('a runtime that spilled nothing pages as before and never reads the spill', async () => {
  const items = archiveItemsForCompaction(
    Array.from({ length: 300 }, (_, n) => row(n)),
    { id: 'it_div' }
  ).items;
  const state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: { rows: 0, epoch: 0 } };
  const entry = liveEntry(state, () => assert.fail('nothing was spilled'));
  const wire = await pageToTop(entry, state);
  assert.deepEqual(
    ids(wire),
    items.map((item) => item.id)
  );
  assert.equal(wire.transcriptHasOlder, false);
});

test('a resumed runtime pages durable history as before, and after its spilled rows when it spilled', async (t) => {
  const sessionId = 'sess_resumed';
  const stored = restoredRows(sessionId);
  const readStoredSession = async () => ({ items: stored, transcriptHasOlder: false });
  // Resumed on the tail from message 6: nothing spilled.
  const resumed = { sessionId, items: stored.slice(6), transcriptArchive: null };
  const unchanged = await pageToTop(
    liveEntry(resumed, () => assert.fail('nothing was spilled')),
    resumed,
    readStoredSession
  );
  assert.deepEqual(
    ids(unchanged),
    stored.map((item) => item.id)
  );
  assert.equal(unchanged.transcriptHasOlder, false);
  // The same runtime with a small cap: messages 6..13 spilled, then durable
  // history above them.
  const { state, spill } = await resumedSpilledRuntime(t, stored, sessionId);
  const wire = await pageToTop(
    liveEntry(state, (range) => spill.readSpilled(range)),
    state,
    readStoredSession
  );
  assert.deepEqual(
    ids(wire),
    stored.map((item) => item.id)
  );
  assert.equal(wire.transcriptHasOlder, false);
});

/** 20 restored rows resumed from message 6 under a cap of 8: messages 6..13
 *  spilled, 14..19 in memory, 0..5 only in durable history. */
async function resumedSpilledRuntime(t, stored, sessionId) {
  const spill = createTranscriptSpillBuffer({ cap: 8, chunkSize: 4, workerFactory: writingWorker });
  t.after(() => spill.dispose());
  const items = spill.capLive(stored.slice(6));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(items[0].id, stored[14].id);
  return { spill, state: { sessionId, items, transcriptArchive: null, transcriptSpilled: spill.spilled } };
}

const restoredRows = (sessionId) => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `m${index}`,
    meta: { transcript: { messageId: `msg_${index}` } },
  }));
  return restoreTranscriptItems(messages, { sessionId });
};

test('a TUI that read back to its oldest spilled page leaves a fresh view paging to the first row', async (t) => {
  const draft = {
    state: {
      items: [],
      transcriptViewItems: null,
      transcriptViewRevision: 0,
      transcriptHistoryBefore: false,
      transcriptHistoryAfter: false,
      structureRevision: 0,
      streamingTail: null,
      promptHistoryList: [],
      stats: {},
    },
  };
  const store = createSessionDraftStore({ draft, listeners: new Set(), isDisposed: () => false, onBusyReleased() {} });
  const spill = createTranscriptSpillBuffer({ workerFactory: writingWorker });
  t.after(() => spill.dispose());
  const transcript = createTranscriptStore({
    draft,
    store,
    flags: { pushingFromDeferredEntry: false, flushDeferredBeforeImmediatePush: null },
    transcriptSpill: spill,
    itemIndexById: new Map(),
    onBulkReplace() {},
  });
  transcript.appendItems(Array.from({ length: 400 }, (_, n) => row(n)));
  transcript.replaceItems(archiveItemsForCompaction(draft.state.items, { id: 'it_div', at: 1 }).items, {
    preserveSpill: true,
  });
  transcript.appendItems(Array.from({ length: 300 }, (_, n) => row(400 + n)));
  await new Promise((resolve) => setImmediate(resolve));
  // The TUI scrolls its own view back to the oldest spilled page.
  while (transcript.restoreOlderTranscript()) {}
  assert.equal(draft.state.transcriptHistoryBefore, false, 'the TUI cursor is at its oldest page');
  assert.ok(draft.state.transcriptSpilled.rows > 0);
  const state = { ...draft.state, sessionId: 's', transcriptArchive: null };
  const wire = await pageToTop(
    liveEntry(state, (range) => spill.readSpilled(range)),
    state
  );
  assert.equal(wire.items[0].id, 'it_0');
  assert.equal(new Set(ids(wire)).size, 701);
  assert.equal(wire.transcriptHasOlder, false);
});

test('a one-shot range across spilled rows and durable history reads both', async (t) => {
  const stored = restoredRows('sess_range');
  const { state, spill } = await resumedSpilledRuntime(t, stored, 'sess_range');
  const readStoredSession = async () => ({ items: stored, transcriptHasOlder: false });
  // Rows 2..9 from the top: 2..5 durable only, 6..9 spilled.
  const range = await readTranscriptRange(
    liveEntry(state, (window) => spill.readSpilled(window)),
    'sess_range',
    readStoredSession,
    { offset: 10, limit: 8 }
  );
  assert.deepEqual(
    range.items.map((item) => item.id),
    stored.slice(2, 10).map((item) => item.id)
  );
  assert.equal(range.hasOlder, true);
});

for (const [name, page] of [
  ['valid JSON that is not a page', { not: 'a page' }],
  ['a truncated page', null],
]) {
  test(`${name} ends the spilled history there, safely`, async (t) => {
    // Pages of 2 rows; the second page written (it_2, it_3) is the bad one.
    const worker = () => {
      const handlers = {};
      return {
        on(event, handler) {
          handlers[event] = handler;
        },
        postMessage({ id, targetPath, items }) {
          const body = id === 2 ? (page ?? items.slice(0, 1)) : items;
          writeFileSync(targetPath, JSON.stringify(body));
          queueMicrotask(() => handlers.message?.({ id, ok: true }));
        },
        terminate() {},
        unref() {},
      };
    };
    const spill = createTranscriptSpillBuffer({ cap: 4, chunkSize: 2, workerFactory: worker });
    t.after(() => spill.dispose());
    const items = spill.capLive(Array.from({ length: 10 }, (_, n) => row(n)));
    await new Promise((resolve) => setImmediate(resolve));
    const { epoch, rows } = spill.spilled;
    const read = spill.readSpilled({ epoch, end: rows, limit: rows });
    assert.deepEqual(
      read.items.map((item) => item.id),
      ['it_4', 'it_5']
    );
    assert.equal(read.broken, true);
    assert.equal(read.start, 4);
    const state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: spill.spilled };
    const wire = await pageToTop(
      liveEntry(state, (window) => spill.readSpilled(window)),
      state
    );
    assert.deepEqual(ids(wire), ['it_4', 'it_5', 'it_6', 'it_7', 'it_8', 'it_9']);
    assert.equal(wire.transcriptHasOlder, false);
  });
}

test('a spill while the reader is paged deep keeps its rows, and paging continues without duplicates or gaps', async (t) => {
  const spill = createTranscriptSpillBuffer({ workerFactory: writingWorker });
  t.after(() => spill.dispose());
  let all = [];
  let items = [];
  const push = (count) => {
    for (let index = 0; index < count; index += 1) {
      const next = row(all.length);
      all = [...all, next];
      items = spill.capLive([...items, next]);
    }
  };
  push(700);
  let state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: spill.spilled };
  const entry = {
    runtime: { getState: () => state, readSpilledTranscript: (range) => spill.readSpilled(range) },
    transcriptView: null,
    publishedSnapshot: null,
  };
  const page = async (wire) => {
    requestLiveTranscriptWindow(entry, { limit: wire.items.length + 64, byteBudget: 1_000_000, pageBase: 0 });
    await loadLiveTranscriptHead(entry, 's', async () => null);
    return windowTranscriptSnapshot(entry, state);
  };
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: 1_000_000, pageBase: 0 });
  let wire = windowTranscriptSnapshot(entry, state);
  // Deep into the spilled rows: about 100 of them loaded.
  while (wire.items.length < items.length + 100) wire = await page(wire);
  const first = wire.items[0].id;
  assert.ok(Number(first.slice(3)) > 0 && Number(first.slice(3)) < 256);
  // The runtime grows by 130 rows and spills another 128-row chunk, among
  // them the window's anchor.
  push(130);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spill.spilled.rows, 384);
  state = { ...state, items, transcriptSpilled: spill.spilled };
  wire = windowTranscriptSnapshot(entry, state);
  const from = all.findIndex((item) => item.id === first);
  assert.deepEqual(
    ids(wire),
    all.slice(from).map((item) => item.id),
    'the window kept its rows and place'
  );
  assert.equal(wire.transcriptHasOlder, true);
  for (let step = 0; wire.transcriptHasOlder && step < 100; step += 1) wire = await page(wire);
  assert.deepEqual(
    ids(wire),
    all.map((item) => item.id)
  );
  assert.equal(wire.transcriptHasOlder, false);
});

for (const [name, respill, expected] of [
  ['to zero spilled rows', 0, []],
  ['to new spilled rows', 6, ['y_0', 'y_1', 'y_2', 'y_3', 'y_4', 'y_5']],
]) {
  test(`a spill reset ${name} while the anchor stays live drops the old epoch's rows`, async (t) => {
    const spill = createTranscriptSpillBuffer({ cap: 4, chunkSize: 2, workerFactory: writingWorker });
    t.after(() => spill.dispose());
    const items = spill.capLive(Array.from({ length: 10 }, (_, n) => row(n)));
    let state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: spill.spilled };
    const entry = {
      runtime: { getState: () => state, readSpilledTranscript: (range) => spill.readSpilled(range) },
      transcriptView: null,
      publishedSnapshot: null,
    };
    const loaded = await pageToTop(entry, state);
    assert.equal(loaded.items[0].id, 'it_0', 'the old epoch was paged in');
    // The store is reset (and refilled with other rows) under the same live rows.
    spill.reset();
    const fresh = Array.from({ length: respill }, (_, n) => ({ ...row(n), id: `y_${n}` }));
    assert.deepEqual(
      spill.capLive([...fresh, ...items]).map((item) => item.id),
      items.map((item) => item.id),
      'the anchor stays live'
    );
    state = { ...state, transcriptSpilled: spill.spilled };
    const wire = windowTranscriptSnapshot(entry, state);
    const old = (snapshot) => ids(snapshot).filter((id) => Number(id.slice(3)) < 6 && id.startsWith('it_'));
    assert.deepEqual(old(wire), [], 'no row of the old epoch stays');
    const paged = await pageToTop(entry, state);
    assert.deepEqual(old(paged), [], 'and none is paged in');
    assert.deepEqual(ids(paged), [...expected, ...items.map((item) => item.id)]);
    assert.equal(paged.transcriptHasOlder, false);
  });
}

test('spilled rows read by absolute index, oldest first, without moving the reading cursor', (t) => {
  const spill = createTranscriptSpillBuffer({ cap: 4, chunkSize: 2, workerFactory: writingWorker });
  t.after(() => spill.dispose());
  const live = spill.capLive(Array.from({ length: 10 }, (_, n) => row(n)));
  assert.deepEqual(
    live.map((item) => item.id),
    ['it_6', 'it_7', 'it_8', 'it_9']
  );
  const { epoch, rows } = spill.spilled;
  assert.equal(rows, 6);
  const page = (end, limit) => {
    const read = spill.readSpilled({ epoch, end, limit });
    return [read.items.map((item) => item.id), read.start];
  };
  assert.deepEqual(page(6, 3), [['it_3', 'it_4', 'it_5'], 3]);
  assert.deepEqual(page(3, 2), [['it_1', 'it_2'], 1]);
  assert.deepEqual(page(1, 4), [['it_0'], 0]);
  assert.equal(spill.readSpilled({ epoch: epoch + 1, end: 6, limit: 1 }), null, 'another epoch reads nothing');
  assert.equal(spill.hasNewer, false, 'the TUI reading cursor never moved');
  spill.reset();
  assert.notEqual(spill.spilled.epoch, epoch);
  assert.equal(spill.spilled.rows, 0);
});
