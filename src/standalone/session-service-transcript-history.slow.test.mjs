// Unbounded transcript history over real storage: a session record of about
// 20,000 rows with a compaction archive, a live runtime that spilled 19,000+
// rows to its spill store, and a runtime resumed on that compacted record.
// A view pages from its tail to the session's first row and stops; every
// answer carries at most TRANSCRIPT_RESPONSE_MAX_ITEMS rows within its byte
// budget, whatever the request names; the display history is built once per
// content version and the store's cache stays within its byte bound.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { waitUntil } from '../runtime/shared/wait-until.test-support.mjs';
import { compactionSegmentLine } from '../runtime/agent/orchestrator/session/compaction-archive.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { createTranscriptSpillBuffer } from '../tui/session/transcript-spill.mjs';
import { TRANSCRIPT_RESPONSE_MAX_ITEMS } from './session-service/projection/transcript-window.mjs';
import { createSessionService } from './session-service.mjs';
import { applySessionStatePatch, transcriptItemsDigest } from './session-state-patch.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-history-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
mkdirSync(join(dataDir, 'sessions'));
const store = await import('../runtime/agent/orchestrator/session/store-summary-reader.mjs');
test.after(() => {
  store.clearStoredTranscriptCache();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const PAGE_BYTES = 1_000_000;
const TAIL = { transcriptItemLimit: 32, transcriptByteBudget: PAGE_BYTES, transcriptPrepend: true };
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MESSAGES = 20_000;
const ARCHIVE_SEGMENTS = 3;
const ARCHIVE_ROWS = 1_000;
const TEXT = 'x'.repeat(900);

const message = (index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index} ${TEXT}` });
const archived = (seq, index) => ({ id: `arch${seq}_${index}`, kind: 'assistant', text: `${seq}.${index} ${TEXT}` });

/** A closed session record of MESSAGES messages, with a compaction archive of
 *  ARCHIVE_SEGMENTS segments when `archive`; settled on disk (old mtimes). */
function writeStoredSession(id, { archive = false } = {}) {
  const messages = Array.from({ length: MESSAGES }, (_, index) => message(index));
  const record = {
    id,
    closed: true,
    generation: 1,
    messages,
    ...(archive ? { compaction: { archive: { nextSeq: ARCHIVE_SEGMENTS + 1 } } } : {}),
  };
  const recordPath = join(dataDir, 'sessions', `${id}.json`);
  writeFileSync(recordPath, JSON.stringify(record));
  const old = new Date(Date.now() - 60_000);
  utimesSync(recordPath, old, old);
  if (archive) {
    const lines = [];
    for (let seq = 1; seq <= ARCHIVE_SEGMENTS; seq += 1) {
      const items = Array.from({ length: ARCHIVE_ROWS }, (_, index) => archived(seq, index));
      lines.push(compactionSegmentLine({ seq, prev: seq > 1 ? seq - 1 : null, at: seq, items }));
    }
    const archivePath = join(dataDir, 'sessions', `${id}.compaction-archive.jsonl`);
    writeFileSync(archivePath, `${lines.join('\n')}\n`);
    utimesSync(archivePath, old, old);
  }
  return { record, recordPath, messages };
}

function storedService(overrides = {}) {
  return createSessionService({
    sessionExists: async (id) => store.storedSessionExists(id),
    statStoredSession: async (id) => store.storedSessionTranscriptStamp(id),
    readStoredSession: async (id, options) => store.readStoredSessionTranscript(id, options),
    forgetStoredSession: (id) => store.forgetStoredSessionTranscript(id),
    releaseStoredSession: (id) => store.releaseStoredSessionTranscript(id),
    createSessionRuntime: async () => {
      throw new Error('cold views never materialize');
    },
    publishIntervalMs: 0,
    idleEvictMs: 600_000,
    evictSweepMs: 600_000,
    ...overrides,
  });
}

/** What the desktop host does: opens a 32-row tail, then pages 64 rows at a
 *  time naming the rows it holds (`transcriptHeld`) and the revision and
 *  stamp it holds, applying each answer — a page above its rows, a patch, or a
 *  whole window. Records the rows and bytes every answer carried. */
function hostView(service, sessionId) {
  const viewer = { clientToken: `host-${sessionId}` };
  let snapshot = null;
  let revision = null;
  let stamp = null;
  const answers = [];
  let digestMs = 0;
  const apply = (result) => {
    let carried = [];
    if (result.page) {
      carried = result.page.items;
      snapshot = { ...result.page.state, items: result.page.items.concat(snapshot.items) };
    } else if (result.full) {
      carried = result.full.items;
      snapshot = result.full;
    } else if (result.patch) {
      carried = [...(result.patch.itemsPrepend?.values ?? []), ...(result.patch.itemsAppend?.values ?? [])];
      snapshot = applySessionStatePatch(snapshot, result.patch);
    }
    answers.push({ rows: carried.length, bytes: Buffer.byteLength(JSON.stringify(carried)) });
    if (Number.isFinite(result.revision)) revision = result.revision;
    // A stored answer names its stamp; an unchanged one keeps it; a live one clears it.
    if (typeof result.projectionStamp === 'string') stamp = result.projectionStamp;
    else if (!result.unchanged) stamp = null;
  };
  return {
    answers,
    get items() {
      return snapshot.items;
    },
    get hasOlder() {
      return snapshot.transcriptHasOlder === true;
    },
    get digestMs() {
      return digestMs;
    },
    /** The host's refresh: its grown window request, naming no held rows. */
    async refresh() {
      const held = snapshot.items.length;
      const result = await service.readSession(
        {
          sessionId,
          transcriptItemLimit: held,
          transcriptByteBudget: PAGE_BYTES,
          transcriptPageBase: held,
          baseRevision: revision,
          ...(stamp ? { baseProjectionStamp: stamp } : {}),
        },
        viewer
      );
      apply(result);
      return result;
    },
    async open() {
      apply(await service.subscribeSession({ sessionId, ...TAIL }, viewer));
    },
    async page(extra = {}) {
      const held = snapshot.items;
      const startedAt = performance.now();
      const digest = transcriptItemsDigest(held);
      digestMs += performance.now() - startedAt;
      apply(
        await service.readSession(
          {
            sessionId,
            transcriptItemLimit: held.length + 64,
            transcriptByteBudget: PAGE_BYTES,
            transcriptPageBase: held.length,
            transcriptPrepend: true,
            transcriptHeld: { firstId: held[0].id, count: held.length, digest },
            baseRevision: revision,
            ...(stamp ? { baseProjectionStamp: stamp } : {}),
            ...extra,
          },
          viewer
        )
      );
    },
    /** Pages until the view says nothing older exists; the pages it took. */
    async scrollToTop() {
      let pages = 0;
      while (this.hasOlder) {
        const held = this.items.length;
        await this.page();
        pages += 1;
        assert.ok(this.items.length > held, `page ${pages} revealed rows (held ${held})`);
      }
      return pages;
    },
  };
}

function assertBoundedAnswers(answers) {
  for (const [index, answer] of answers.entries()) {
    assert.ok(answer.rows <= TRANSCRIPT_RESPONSE_MAX_ITEMS, `answer ${index}: ${answer.rows} rows`);
    assert.ok(answer.bytes <= PAGE_BYTES, `answer ${index}: ${answer.bytes} bytes`);
  }
  return {
    maxRows: Math.max(...answers.map((answer) => answer.rows)),
    maxBytes: Math.max(...answers.map((answer) => answer.bytes)),
  };
}

/** The restored rows of the record, in order: hist ids by message index. */
function assertRestoredRows(items, sessionId) {
  const indices = items.map((item) => Number(/^hist_.+_(\d+)_\d+$/.exec(String(item.id))?.[1]));
  assert.equal(indices.length, MESSAGES);
  for (const [position, value] of indices.entries()) assert.equal(value, position, `restored row ${position}`);
  assert.ok(items.every((item) => String(item.id).startsWith(`hist_${sessionId}_`)));
}

test('a compacted stored session pages from its tail to its first archived row in bounded answers, built once', async (t) => {
  const id = 'sess_history_cold';
  const { record, recordPath, messages } = writeStoredSession(id, { archive: true });
  store.clearStoredTranscriptCache();
  const service = storedService();
  try {
    const view = hostView(service, id);
    const startedAt = performance.now();
    await view.open();
    const pages = await view.scrollToTop();
    const elapsed = performance.now() - startedAt;
    const rows = view.items;
    const archivedRows = ARCHIVE_SEGMENTS * ARCHIVE_ROWS;
    assert.equal(rows.length, archivedRows + MESSAGES, 'every row, once');
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'no duplicates');
    assert.equal(rows[0].id, 'arch1_0', 'the first row of the oldest archive segment');
    assert.deepEqual(
      rows.slice(0, archivedRows).map((row) => row.id),
      Array.from({ length: ARCHIVE_SEGMENTS }, (_, seq) =>
        Array.from({ length: ARCHIVE_ROWS }, (_, index) => `arch${seq + 1}_${index}`)
      ).flat()
    );
    assertRestoredRows(rows.slice(archivedRows), id);
    assert.equal(view.hasOlder, false, 'it stops at the start');
    const bounds = assertBoundedAnswers(view.answers);
    const stats = store.storedTranscriptCacheStats();
    assert.equal(stats.builds, 1, 'one display history for the whole scroll');
    assert.ok(stats.retainedBytes <= CACHE_MAX_BYTES);
    t.diagnostic(
      `cold rows=${rows.length} pages=${pages} builds=${stats.builds} maxAnswerRows=${bounds.maxRows}` +
        ` maxAnswerBytes=${bounds.maxBytes} cacheBytes=${stats.retainedBytes} elapsedMs=${Math.round(elapsed)}` +
        ` hostDigestMs=${Math.round(view.digestMs)}`
    );

    // Changed content is a new version: built again, and the view that held
    // the old one is answered with a bounded fresh tail.
    writeFileSync(recordPath, JSON.stringify({ ...record, messages: [...messages, message(MESSAGES)] }));
    await view.page();
    assert.equal(store.storedTranscriptCacheStats().builds, 2);
    assert.ok(view.items.length <= TRANSCRIPT_RESPONSE_MAX_ITEMS);
    assert.equal(view.hasOlder, true);
    assertBoundedAnswers(view.answers);
  } finally {
    await service.stop('test complete');
  }
});

test('one answer never carries more than its bounds, whatever limit, base or held rows it names', async () => {
  const id = 'sess_history_cold';
  writeStoredSession(id, { archive: true });
  store.clearStoredTranscriptCache();
  const service = storedService();
  try {
    const answers = [];
    const read = async (params) => {
      const result = await service.readSession({ sessionId: id, transcriptPrepend: true, ...params });
      const rows = result.page ? result.page.items : result.full.items;
      answers.push({ rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
      return { result, rows };
    };
    const huge = { transcriptItemLimit: 10_000_000, transcriptPageBase: 10_000_000 };
    // A request naming no held rows keeps its earlier ceiling.
    const legacy = await read(huge);
    assert.equal(legacy.rows.length, 8_192, 'no held rows named: the earlier 8,192-row window');
    // A paged request (it names held rows, here none it holds) is clamped.
    const forgedHeld = { transcriptHeld: { firstId: 'arch1_0', count: 1, digest: 'forged' } };
    const budget = 200_000;
    const unbudgeted = await read({ ...huge, ...forgedHeld });
    assert.equal(unbudgeted.rows.length, TRANSCRIPT_RESPONSE_MAX_ITEMS, 'no budget named: the row bound');
    const budgeted = await read({ ...huge, ...forgedHeld, transcriptByteBudget: budget });
    assert.ok(budgeted.rows.length < TRANSCRIPT_RESPONSE_MAX_ITEMS, 'rows of ~1 KB: the byte budget cuts first');
    assert.ok(answers.at(-1).bytes <= budget);
    const tiny = await read({ ...huge, ...forgedHeld, transcriptByteBudget: 1 });
    assert.equal(tiny.rows.length, 8, 'a one-byte budget keeps the eight-row floor');
    // Proven held rows and a huge limit: at most one page above them.
    const held = budgeted.rows;
    const proven = await read({
      ...huge,
      transcriptHeld: { firstId: held[0].id, count: held.length, digest: transcriptItemsDigest(held) },
    });
    assert.ok(proven.result.page, 'answered as a page');
    assert.equal(proven.rows.length, TRANSCRIPT_RESPONSE_MAX_ITEMS);
    // A forged digest of the held rows proves nothing: a bounded fresh tail.
    const forged = await read({
      ...huge,
      transcriptByteBudget: budget,
      transcriptHeld: { firstId: held[0].id, count: held.length, digest: 'forged' },
    });
    assert.equal(forged.result.page, undefined);
    assert.deepEqual(forged.rows, budgeted.rows);
    assert.ok(answers.at(-1).bytes <= budget);
    assert.ok(answers.slice(1).every((answer) => answer.rows <= TRANSCRIPT_RESPONSE_MAX_ITEMS));
  } finally {
    await service.stop('test complete');
  }
});

test('a request without held rows pages on past a byte-budget cut, and a deeper paged host keeps its rows', async () => {
  const id = 'sess_history_cold';
  writeStoredSession(id, { archive: true });
  store.clearStoredTranscriptCache();
  const service = storedService();
  try {
    // The reviewer's probe: 512 rows asked, a one-byte budget delivers eight.
    const old = { clientToken: 'old-host' };
    const first = await service.readSession({ sessionId: id, transcriptItemLimit: 512, transcriptByteBudget: 1 }, old);
    assert.equal(first.full.items.length, 8);
    const next = await service.readSession(
      {
        sessionId: id,
        transcriptItemLimit: 72,
        transcriptByteBudget: 1,
        transcriptPageBase: 8,
        baseRevision: first.revision,
        baseProjectionStamp: first.projectionStamp,
      },
      old
    );
    assert.notEqual(next.unchanged, true, 'the eight rows delivered do not cover the page');
    assert.equal(next.full.items.length, 16, 'eight more above the eight held');
    assert.deepEqual(
      next.full.items.slice(-8).map((row) => row.id),
      first.full.items.map((row) => row.id)
    );
    // A host paged past the 8,192-row window: its refresh keeps its rows.
    const view = hostView(service, id);
    await view.open();
    while (view.items.length <= 8_192) await view.page();
    const held = view.items.length;
    const refreshed = await view.refresh();
    assert.equal(refreshed.unchanged, true);
    assert.equal(view.items.length, held);
  } finally {
    await service.stop('test complete');
  }
});

/** A live runtime over `state()`, publishing on `update`. */
function liveRuntime(initial, extra = {}) {
  let state = initial;
  let listener = () => {};
  return {
    runtime: {
      isWireSafe: true,
      getState: () => state,
      subscribe(next) {
        listener = next;
        return () => {};
      },
      dispose: async () => {},
      ...extra,
    },
    update(next) {
      state = next;
      listener();
    },
  };
}

test('a live runtime that spilled 19,000+ rows pages through its spill store to its first row', async (t) => {
  const id = 'sess_history_spilled';
  const spill = createTranscriptSpillBuffer();
  t.after(() => spill.dispose());
  const all = Array.from({ length: MESSAGES }, (_, index) => ({
    id: `it_${index}`,
    kind: index % 2 ? 'assistant' : 'user',
    text: `${index} ${TEXT}`,
  }));
  const items = spill.capLive(all);
  await waitUntil(() => spill.pendingWriteCount === 0, { timeoutMs: 60_000, message: 'spill pages written' });
  assert.ok(spill.spilled.rows > 19_000);
  const live = liveRuntime(
    { sessionId: id, items, queued: [], transcriptSpilled: spill.spilled },
    { readSpilledTranscript: (range) => spill.readSpilled(range) }
  );
  const service = storedService({ createSessionRuntime: async () => live.runtime, sessionExists: async () => true });
  try {
    await service.createSession({ sessionId: id });
    const view = hostView(service, id);
    const startedAt = performance.now();
    await view.open();
    const pages = await view.scrollToTop();
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(
      view.items.map((row) => row.id),
      all.map((row) => row.id),
      'every row, in order, from the first'
    );
    assert.equal(view.hasOlder, false);
    const bounds = assertBoundedAnswers(view.answers);
    t.diagnostic(
      `live-spilled rows=${view.items.length} spilledRows=${spill.spilled.rows} pages=${pages}` +
        ` maxAnswerRows=${bounds.maxRows} maxAnswerBytes=${bounds.maxBytes} elapsedMs=${Math.round(elapsed)}`
    );
  } finally {
    await service.stop('test complete');
  }
});

test('a runtime resumed on a compacted record pages its durable history and archive from one cached build', async (t) => {
  const id = 'sess_history_resumed';
  const { messages } = writeStoredSession(id, { archive: true });
  store.clearStoredTranscriptCache();
  const restored = restoreTranscriptItems(messages, { sessionId: id, itemLimit: 512 });
  const live = liveRuntime({ sessionId: id, items: restored, queued: [] });
  const service = storedService({ createSessionRuntime: async () => live.runtime, sessionExists: async () => true });
  try {
    await service.createSession({ sessionId: id });
    const view = hostView(service, id);
    const startedAt = performance.now();
    await view.open();
    const pages = await view.scrollToTop();
    const elapsed = performance.now() - startedAt;
    const rows = view.items;
    const archivedRows = ARCHIVE_SEGMENTS * ARCHIVE_ROWS;
    assert.equal(rows.length, archivedRows + MESSAGES);
    assert.equal(rows[0].id, 'arch1_0');
    assertRestoredRows(rows.slice(archivedRows), id);
    assert.equal(view.hasOlder, false);
    const bounds = assertBoundedAnswers(view.answers);
    const stats = store.storedTranscriptCacheStats();
    assert.equal(stats.builds, 1, 'the durable history was built once for the whole scroll');
    t.diagnostic(
      `live-resumed rows=${rows.length} pages=${pages} builds=${stats.builds} maxAnswerRows=${bounds.maxRows}` +
        ` maxAnswerBytes=${bounds.maxBytes} elapsedMs=${Math.round(elapsed)}`
    );
  } finally {
    await service.stop('test complete');
  }
});

test('a session being paged stays cached while two other large sessions are read around it', async (t) => {
  store.clearStoredTranscriptCache();
  for (const id of ['sess_paged_a', 'sess_paged_b', 'sess_paged_c']) writeStoredSession(id);
  // b and c fill the cache first; a is read once and evicted.
  for (const id of ['sess_paged_a', 'sess_paged_b', 'sess_paged_c']) {
    await store.readStoredSessionTranscript(id, { transcriptItemLimit: 32 });
  }
  const before = store.storedTranscriptCacheStats().builds;
  const pageHits = [];
  let otherReads = 0;
  for (let page = 1; page <= 8; page += 1) {
    await store.readStoredSessionTranscript('sess_paged_a', {
      transcriptItemLimit: 32 + page * 64,
      paging: true,
      trace: (entry) => pageHits.push(entry.hit),
    });
    await store.readStoredSessionTranscript(page % 2 ? 'sess_paged_b' : 'sess_paged_c', { transcriptItemLimit: 32 });
    otherReads += 1;
    assert.ok(store.storedTranscriptCacheStats().retainedBytes <= CACHE_MAX_BYTES);
  }
  const builds = store.storedTranscriptCacheStats().builds - before;
  assert.deepEqual(pageHits, [false, true, true, true, true, true, true, true], 'the paged history is built once');
  assert.ok(builds <= 1 + otherReads, `${builds} builds`);
  t.diagnostic(`alternating builds=${builds} (paged session 1, other reads ${otherReads})`);
});

test('the store cache keeps the newest display history and stays within its byte bound', async (t) => {
  store.clearStoredTranscriptCache();
  writeStoredSession('sess_history_first');
  writeStoredSession('sess_history_second');
  writeStoredSession('sess_history_third');
  const sizes = [];
  for (const id of ['sess_history_first', 'sess_history_second', 'sess_history_third']) {
    const window = await store.readStoredSessionTranscript(id, { transcriptItemLimit: 64 });
    assert.equal(window.items.length, 64);
    const stats = store.storedTranscriptCacheStats();
    sizes.push(stats.retainedBytes);
    assert.ok(stats.retainedBytes <= CACHE_MAX_BYTES, `${stats.retainedBytes} retained bytes`);
  }
  const stats = store.storedTranscriptCacheStats();
  assert.equal(stats.builds, 3);
  // Each history is ~20 MB: two do not fit, so the older one went.
  assert.equal(stats.entries, 1);
  const again = await store.readStoredSessionTranscript('sess_history_third', { transcriptItemLimit: 128 });
  assert.equal(again.items.length, 128);
  assert.equal(store.storedTranscriptCacheStats().builds, 3, 'the newest is still cached');
  t.diagnostic(`cache retainedBytes after each read=${sizes.join(',')} entries=${stats.entries}`);
});
