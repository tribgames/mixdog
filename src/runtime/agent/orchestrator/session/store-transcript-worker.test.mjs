// The off-thread stored transcript projection (shared base per content,
// parsed-prefix reuse across versions, concurrent reads sharing one
// projection) must answer exactly what a fresh in-process projection of the
// same bytes answers: projections feed the transcript.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-worker-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir);

const { readStoredSessionTranscript, clearStoredTranscriptCache } = await import('./store-summary-reader.mjs');
const { projectStoredTranscript } = await import('./store-transcript-projection.mjs');
const { readTopLevelLifecycleRecord } = await import('./lifecycle-scan.mjs');
const { OFFLOAD_MIN_CHARS, RESTART_READ, createBaseBuilds, createHistoryRetention, reuseParsedPrefix, sameJsonValue } =
  await import('./store-transcript-worker.mjs');
const { heldRowsDigester, storedHistorySlice } = await import('./store-transcript-projection.mjs');
const { contextMessagesSignature, toolSchemaSignature } = await import('./context-utils.mjs');

test.after(() => {
  clearStoredTranscriptCache();
  rmSync(dataDir, { recursive: true, force: true });
});

const OPAQUE = 'A'.repeat(96);
const IMAGE_PLACEHOLDER = '[Image omitted from stored history: image/png 1.2 MB]';

/** One turn of a real-shaped transcript: a prompt (text + image placeholder),
 *  reasoning with provider replay, parallel tool calls with their results
 *  (one failing, one carrying a diff) and a final answer. */
function turnMessages(turn, at) {
  const read = `call_read_${turn}`;
  const patch = `call_patch_${turn}`;
  const shell = `call_shell_${turn}`;
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: `turn ${turn}: please review module ${turn} ${'context '.repeat(150)}` },
        { type: 'text', text: IMAGE_PLACEHOLDER },
      ],
      meta: { transcript: { at } },
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `plan ${turn} ${'reason '.repeat(60)}`, signature: OPAQUE },
        { type: 'text', text: `Looking at module ${turn}.` },
      ],
      toolCalls: [
        { id: read, name: 'read', arguments: { path: `src/module-${turn}.mjs` } },
        { id: patch, name: 'apply_patch', arguments: { patch: `*** Update File: src/module-${turn}.mjs` } },
        { id: shell, name: 'shell', arguments: { command: `node --test module-${turn}` } },
      ],
      providerReplay: { items: [{ type: 'reasoning', id: `rs_${turn}`, encrypted_content: OPAQUE, summary: [] }] },
      meta: { transcript: { at: at + 1 } },
    },
    { role: 'tool', toolCallId: read, content: `export const value${turn} = ${turn};\n${'// line\n'.repeat(120)}` },
    {
      role: 'tool',
      toolCallId: patch,
      content: `Success. Updated src/module-${turn}.mjs\n${'+ added line\n- removed line\n'.repeat(40)}`,
    },
    { role: 'tool', toolCallId: shell, content: `Error: exit code 1\nnot ok ${turn} - assertion failed` },
    {
      role: 'assistant',
      content: `Module ${turn} is fixed. ${'summary '.repeat(120)}`,
      meta: { transcript: { at: at + 2 } },
    },
  ];
}

function sessionDocument(id, turns) {
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < turns; turn += 1) messages.push(...turnMessages(turn, 1_700_000_000_000 + turn * 10));
  const tools = [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' } }];
  return {
    id,
    owner: 'user',
    agent: 'lead',
    closed: false,
    generation: 4,
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    cwd: dataDir,
    contextWindow: 272_000,
    rawContextWindow: 272_000,
    compactBoundaryTokens: 272_000,
    messages,
    tools,
    compaction: { auto: true, boundaryTokens: 272_000, triggerTokens: 240_000 },
    // A provider baseline over the transcript as written: the gauge reads the
    // signature chains the projection primes, and every later version adds
    // its tail estimate on top of it.
    lastContextTokens: 90_000,
    lastContextTokensUpdatedAt: 1_700_000_000_500,
    contextPressureBaselineTokens: 90_000,
    contextPressureBaselineOutputTokens: 0,
    contextPressureBaselineMessageCount: messages.length,
    contextPressureBaselinePrefixSignature: contextMessagesSignature(messages),
    contextPressureBaselineProvider: 'openai-oauth',
    contextPressureBaselineModel: 'gpt-5.6-sol',
    contextPressureBaselineToolSignature: toolSchemaSignature(tools),
    contextPressureBaselineBoundary: 'complete',
    contextPressureBaselineUpdatedAt: 1_700_000_000_500,
    lastContextTokensStaleAfterCompact: false,
  };
}

const fileOf = (id) => join(sessionsDir, `${id}.json`);
function write(doc) {
  const text = JSON.stringify(doc);
  writeFileSync(`${fileOf(doc.id)}.tmp`, text);
  renameSync(`${fileOf(doc.id)}.tmp`, fileOf(doc.id));
  return text;
}

/** The reference: a fresh in-process projection of exactly these bytes. */
async function fresh(id, text, itemLimit) {
  const value = await projectStoredTranscript(id, readTopLevelLifecycleRecord(text).doc, {
    itemLimit,
    includeMessages: false,
    checkpointAbsent: true,
  });
  const { projectionStamp, ...rest } = value;
  return rest;
}

async function served(id, itemLimit) {
  let trace = null;
  const value = await readStoredSessionTranscript(id, {
    transcriptItemLimit: itemLimit,
    trace: (entry) => {
      trace = entry;
    },
  });
  const { projectionStamp, ...rest } = value;
  return { value: rest, trace };
}

const WINDOWS = [16, 64, 4096];

async function assertEquivalent(id, text, label) {
  const traces = [];
  for (const limit of WINDOWS) {
    const { value, trace } = await served(id, limit);
    traces.push(trace);
    assert.deepEqual(value, await fresh(id, text, limit), `${label}: window ${limit}`);
  }
  return traces;
}

test('the fixture is large enough to take the off-thread path', () => {
  assert.ok(JSON.stringify(sessionDocument('sess_size_probe', 60)).length >= OFFLOAD_MIN_CHARS);
});

test('off-thread projections equal fresh ones across windows, appends, edits and compaction', async () => {
  const id = `sess_worker_equivalence_${process.pid}`;
  const doc = sessionDocument(id, 60);
  clearStoredTranscriptCache();
  const first = await assertEquivalent(id, write(doc), 'initial');
  assert.equal(first[0].timing.worker !== undefined, true, 'served by the worker');
  assert.deepEqual(
    first.map((trace) => trace.hit),
    [false, true, true],
    'every other window of the same content is cut from the one projected history'
  );

  // An appended turn: the previous version's parsed messages are reused.
  doc.messages.push(...turnMessages(60, 1_700_000_001_000));
  doc.updatedAt = 1_700_000_001_000;
  const appended = await assertEquivalent(id, write(doc), 'appended');
  assert.ok(appended[0].timing.reusedMessages > 300, 'the unchanged prefix was reused');
  const { stats } = (await served(id, 16)).value;
  assert.equal(stats.currentContextSource, 'last_api_request', 'the measured gauge path was projected');

  // An edited middle message stops the reuse there; everything after it
  // (same values as before) is metered again.
  doc.messages[150] = { ...doc.messages[150], content: `${doc.messages[150].content} (edited)` };
  const edited = await assertEquivalent(id, write(doc), 'edited middle');
  assert.equal(edited[0].timing.reusedMessages, 150);

  // A key-order change is a different serialization: never reused.
  const moved = doc.messages[10];
  const { role, ...others } = moved;
  doc.messages[10] = { ...others, role };
  const reordered = await assertEquivalent(id, write(doc), 'reordered keys');
  assert.equal(reordered[0].timing.reusedMessages, 10);

  // Compaction rewrites the head: nothing is reused, output still exact.
  doc.messages = [
    doc.messages[0],
    { role: 'user', content: 'Compacted conversation summary' },
    ...doc.messages.slice(-300),
  ];
  const compacted = await assertEquivalent(id, write(doc), 'compacted');
  assert.equal(compacted[0].timing.reusedMessages, 1);

  // Shrinking back to a previously served version is exact too.
  doc.messages = doc.messages.slice(0, -6);
  await assertEquivalent(id, write(doc), 'truncated');
});

test('concurrent reads of one session share one projection', async () => {
  const id = `sess_worker_concurrent_${process.pid}`;
  const text = write(sessionDocument(id, 50));
  // Only a file past the racy window (2.5 s, ctime included) is vouched for
  // by its stat, which is what lets a caller join a read already under way.
  await new Promise((resolve) => setTimeout(resolve, 2_700));
  clearStoredTranscriptCache();
  const traces = [];
  const trace = (entry) => traces.push(entry);
  const reads = await Promise.all([
    readStoredSessionTranscript(id, { transcriptItemLimit: 32, trace }),
    readStoredSessionTranscript(id, { transcriptItemLimit: 32, trace }),
    readStoredSessionTranscript(id, { transcriptItemLimit: 32, trace }),
    readStoredSessionTranscript(id, { transcriptItemLimit: 64, trace }),
  ]);
  assert.equal(reads[1], reads[0], 'same window: one projection object');
  assert.equal(reads[2], reads[0]);
  const misses = traces.filter((entry) => !entry.hit);
  assert.equal(misses.length, 1, 'one projected history serves every window');
  const { projectionStamp, ...wide } = reads[3];
  assert.deepEqual(wide, await fresh(id, text, 64));
});

test('the worker keeps display histories within its per-session and total byte budgets', () => {
  const retention = createHistoryRetention({ sessionMaxBytes: 100, maxBytes: 150 });
  const history = (bytes) => ({ value: { items: [] }, rowBytes: new Float64Array(0), bytes });
  assert.equal(retention.retain('huge', 'c', 'f', history(101)), false, 'larger than one session may hold');
  assert.equal(retention.get('huge', 'c', 'f'), null);
  assert.equal(retention.retain('a', 'c', 'f', history(80)), true);
  assert.equal(retention.retain('b', 'c', 'f', history(60)), true);
  assert.deepEqual(retention.stats(), { histories: 2, retainedBytes: 140 });
  assert.equal(retention.retain('c', 'c', 'f', history(60)), true);
  assert.deepEqual(retention.stats(), { histories: 2, retainedBytes: 120 }, 'the oldest went');
  assert.equal(retention.get('a', 'c', 'f'), null);
  assert.equal(retention.get('b', 'other content', 'f'), null, 'never another content');
  assert.equal(retention.get('b', 'c', 'other sidecars'), null);
  retention.forget('b');
  assert.deepEqual(retention.stats(), { histories: 1, retainedBytes: 60 });
});

test('a page above held rows is bounded by rows and bytes at any depth, and proven by stamp or digest', async () => {
  const items = Array.from({ length: 50_000 }, (_, index) => ({
    id: `r${index}`,
    kind: 'assistant',
    text: 'y'.repeat(100),
  }));
  const history = { items, transcriptHasOlder: false, transcriptArchivedRows: 0, model: 'm' };
  const digestOf = await heldRowsDigester();
  const { transcriptItemsDigest } = await import('../../../../standalone/session-state-patch.mjs');
  for (const count of [32, 20_000, 49_990]) {
    const held = { firstId: `r${50_000 - count}`, count, digest: 'stale' };
    const page = storedHistorySlice(
      history,
      { limit: count + 512, held, proven: true, maxRows: 512, byteBudget: 10_000 },
      { digestOf }
    );
    assert.equal(page.heldProven, true);
    assert.equal(page.items.at(-1).id, `r${50_000 - count - 1}`, 'directly above the held rows');
    assert.ok(page.items.length <= 512 && page.items.length >= Math.min(8, 50_000 - count));
    const bytes = page.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    assert.ok(bytes <= 10_000 || page.items.length <= 8, `${bytes} bytes`);
    assert.equal(page.transcriptHasOlder, 50_000 - count - page.items.length > 0);
    assert.equal(page.model, 'm');
  }
  // Another history (a restart): the digest proves them; a forged one does not.
  const held = items.slice(30_000);
  const request = { limit: 20_512, maxRows: 512 };
  const real = { firstId: held[0].id, count: held.length, digest: transcriptItemsDigest(held) };
  const proven = storedHistorySlice(history, { ...request, held: real }, { digestOf });
  assert.equal(proven.heldProven, true);
  assert.equal(proven.items.length, 512);
  const forged = storedHistorySlice(history, { ...request, held: { ...real, digest: 'forged' } }, { digestOf });
  assert.equal(forged.heldProven, false);
  assert.deepEqual(
    forged.items.map((item) => item.id),
    items.slice(-512).map((item) => item.id),
    'unproven: a fresh tail of one answer'
  );
  // A stale proof's tail keeps the byte budget (rows of ~150 B: well below 512).
  const budgeted = storedHistorySlice(
    history,
    { ...request, held: { ...real, digest: 'stale' }, byteBudget: 10_000 },
    { digestOf }
  );
  const tailBytes = budgeted.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  assert.equal(budgeted.heldProven, false);
  assert.ok(tailBytes <= 10_000 && budgeted.items.length >= 8, `${budgeted.items.length} rows, ${tailBytes} bytes`);
  assert.equal(budgeted.items.at(-1).id, 'r49999');
  const huge = { ...history, items: items.slice(-20).map((item) => ({ ...item, text: 'z'.repeat(50_000) })) };
  const floor = storedHistorySlice(
    huge,
    { limit: 600, maxRows: 512, byteBudget: 10_000, held: { firstId: 'nope', count: 3, digest: 'x' } },
    { digestOf }
  );
  assert.equal(floor.items.length, 8, 'the eight-row floor still holds');
});

test('a main-thread cursor read for a row it cannot find stops at its bound and answers missing; pages hold 512 rows', async (t) => {
  const id = `sess_cursor_missing_${process.pid}`;
  const messages = Array.from({ length: 12_000 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}`,
  }));
  writeFileSync(fileOf(id), JSON.stringify({ id, closed: true, generation: 1, messages }));
  mkdirSync(join(sessionsDir, '..', 'turn-checkpoints'), { recursive: true });
  const checkpointPath = join(sessionsDir, '..', 'turn-checkpoints', `${id}.json`);
  writeFileSync(checkpointPath, '{}');
  t.after(() => rmSync(checkpointPath, { force: true }));
  clearStoredTranscriptCache();
  const traces = [];
  const missing = await readStoredSessionTranscript(id, {
    transcriptCursor: { before: 'no_such_row', maxRows: 8 },
    trace: (entry) => traces.push(entry.timing.cursorWindowItems),
  });
  assert.equal(missing.cursorMissing, true);
  assert.deepEqual(traces, [8_192], 'never a window past 8,192 rows of the 12,000');
  const tail = await readStoredSessionTranscript(id, { transcriptItemLimit: 4 });
  const clamped = await readStoredSessionTranscript(id, {
    transcriptCursor: { before: tail.items[0].id, maxRows: 1_000 },
  });
  assert.equal(clamped.items.length, 512);
  const items = Array.from({ length: 2_000 }, (_, index) => ({ id: `r${index}` }));
  const sliced = storedHistorySlice({ items }, { cursor: { before: 'r1999', maxRows: 1_000 } });
  assert.equal(sliced.items.length, 512);
});

test('a cursor read on the main thread (checkpoint or worker failure) projects only the window reaching its row', async (t) => {
  const id = `sess_cursor_bounded_${process.pid}`;
  const messages = Array.from({ length: 4_000 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index} ${'w'.repeat(400)}`,
  }));
  writeFileSync(fileOf(id), JSON.stringify({ id, closed: true, generation: 1, messages }));
  // A checkpoint sidecar keeps the read on this thread.
  mkdirSync(join(sessionsDir, '..', 'turn-checkpoints'), { recursive: true });
  const checkpointPath = join(sessionsDir, '..', 'turn-checkpoints', `${id}.json`);
  writeFileSync(checkpointPath, '{}');
  t.after(() => rmSync(checkpointPath, { force: true }));
  clearStoredTranscriptCache();
  const projection = await import('./store-transcript-projection.mjs');
  const traces = [];
  const tail = await readStoredSessionTranscript(id, { transcriptItemLimit: 16 });
  const boundary = tail.items[0].id;
  const page = await readStoredSessionTranscript(id, {
    transcriptCursor: { before: boundary, maxRows: 64, byteBudget: 1_000_000 },
    trace: (entry) => traces.push(entry),
  });
  assert.equal(page.items.length, 64);
  assert.equal(page.transcriptHasNewer, true);
  assert.ok(page.items.at(-1).id !== boundary);
  // The served answer is the 64-row page; nothing like the 4,000-row history
  // was sliced, and the reference projection of the same window agrees.
  const reference = await projection.projectStoredTranscript(id, JSON.parse(readFileSync(fileOf(id), 'utf8')), {
    itemLimit: 80,
    includeMessages: false,
    checkpointAbsent: false,
  });
  assert.deepEqual(
    page.items.map((item) => item.id),
    reference.items.slice(0, 64).map((item) => item.id)
  );
  assert.deepEqual(
    traces.map((entry) => [entry.items, entry.timing.cursorWindowItems]),
    [[64, 128]],
    'one 128-row window projected, not the 4,000-row history'
  );
});

// What the worker does per request: reserve room, then read and submit.
async function readAndSubmit(builds, sessionId, chars, fill, timing = {}) {
  const ticket = await builds.admit(chars);
  let text = Buffer.alloc(chars, fill).toString('latin1');
  const pending = builds.submit(sessionId, text, `${fill}:${chars}`, ticket, timing);
  text = null;
  return pending;
}

const MB = 1024 * 1024;

test('a burst of distinct large records stays within the build budget', async () => {
  const limit = 4 * MB;
  const count = 32;
  let builds = null;
  let peakQueuedChars = 0;
  let peakReserved = 0;
  let peakHeap = 0;
  let heapBase = 0;
  // Large decoded strings may live outside the V8 heap proper.
  const heap = () => {
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.external;
  };
  builds = createBaseBuilds({
    buildCharsLimit: limit,
    baseCharsLimit: MB,
    build: async (_sessionId, text) => {
      const stats = builds.stats();
      peakQueuedChars = Math.max(peakQueuedChars, stats.queuedChars);
      peakReserved = Math.max(peakReserved, stats.reservedChars);
      gc();
      peakHeap = Math.max(peakHeap, heap() - heapBase);
      await sleep(2);
      return { messages: [], chars: text.length };
    },
  });
  gc();
  heapBase = heap();
  const answers = await Promise.all(
    Array.from({ length: count }, (_, index) => readAndSubmit(builds, `sess_burst_${index}`, MB, 'a'))
  );
  assert.ok(
    answers.every((answer) => answer.chars === MB),
    'every record was built'
  );
  const stats = builds.stats();
  assert.equal(stats.builds, count);
  assert.ok(stats.peakReservedChars <= limit, `reserved ${stats.peakReservedChars} > ${limit}`);
  assert.ok(peakReserved <= limit && peakQueuedChars < limit, `queued ${peakQueuedChars}`);
  assert.equal(stats.reservedChars, 0, 'every reservation was released');
  assert.equal(stats.waitingAdmissions, 0);
  // Unbounded, all 32 one-byte bodies are alive at once (measured ~62 MB;
  // bounded ~6 MB).
  assert.ok(peakHeap < 12 * MB, `heap grew ${Math.round(peakHeap / MB)} MB during the burst`);
});

test('a record larger than the budget is admitted alone', async () => {
  const builds = createBaseBuilds({ buildCharsLimit: 10, build: async () => ({ messages: [] }) });
  const big = await builds.admit(25);
  let small = null;
  void builds.admit(5).then((ticket) => {
    small = ticket;
  });
  await nextTurn();
  assert.equal(small, null, 'waits behind the oversized reservation');
  builds.release(big);
  await nextTurn();
  assert.equal(small?.chars, 5);
});

test('a newer version replaces its queued older build, which never runs', async () => {
  const built = [];
  let open = null;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const builds = createBaseBuilds({
    build: async (sessionId, text, previous) => {
      built.push(`${sessionId}:${text[0]}:${previous ? previous[0] : '-'}`);
      if (built.length === 1) await gate;
      return { messages: [text[0]] };
    },
  });
  const first = builds.submit('s', 'a'.repeat(10), 'a', await builds.admit(10), {});
  const second = builds.submit('s', 'b'.repeat(10), 'b', await builds.admit(10), {});
  const sharer = {};
  const secondShared = builds.submit('s', 'b'.repeat(10), 'b', await builds.admit(10), sharer);
  assert.equal(sharer.base, 'shared', 'the same queued content is joined, not queued twice');
  const third = builds.submit('s', 'c'.repeat(10), 'c', await builds.admit(10), {});
  assert.equal(await second, RESTART_READ, 'the superseded build answers: read again');
  assert.equal(await secondShared, RESTART_READ);
  assert.equal(builds.stats().queuedBuilds, 1);
  assert.equal(builds.stats().reservedChars, 20, 'the dropped body is no longer reserved');
  open();
  await first;
  assert.deepEqual((await third).messages, ['c']);
  assert.deepEqual(built, ['s:a:-', 's:c:a'], 'b never ran; c reused a');
  assert.equal(builds.stats().reservedChars, 0);
});

test('forgetting a session drops its queued builds and keeps no base', async () => {
  const built = [];
  const gates = new Map();
  const builds = createBaseBuilds({
    build: async (sessionId) => {
      built.push(sessionId);
      await gates.get(sessionId);
      return { messages: [sessionId] };
    },
  });
  let openRunning = null;
  gates.set('live', new Promise((resolve) => (openRunning = resolve)));
  const running = builds.submit('live', 'x'.repeat(10), 'x', await builds.admit(10), {});
  const queued = builds.submit('live-too', 'y'.repeat(10), 'y', await builds.admit(10), {});
  const other = builds.submit('other', 'z'.repeat(10), 'z', await builds.admit(10), {});
  builds.forget('live-too');
  builds.forget('live');
  assert.equal(await queued, RESTART_READ);
  openRunning();
  assert.deepEqual((await running).messages, ['live'], 'a running build still answers its waiters');
  await other;
  assert.deepEqual(built, ['live', 'other'], 'the forgotten queued build never ran');
  assert.deepEqual(
    { retainedBases: builds.stats().retainedBases, reservedChars: builds.stats().reservedChars },
    { retainedBases: 1, reservedChars: 0 },
    'only the unforgotten base is retained'
  );
});

test('a queued build keeps no evicted previous version alive', async () => {
  const gates = new Map();
  const previousSeen = [];
  let firstMessages = null;
  const builds = createBaseBuilds({
    baseCharsLimit: 15,
    build: async (sessionId, text, previous) => {
      if (sessionId === 's') previousSeen.push(previous);
      await gates.get(sessionId);
      const messages = [{ body: `${sessionId}${text}`.repeat(1000) }];
      if (sessionId === 's' && !firstMessages) firstMessages = new WeakRef(messages);
      return { messages };
    },
  });
  await builds.submit('s', 'a'.repeat(10), 'a', await builds.admit(10), {});
  let openG = null;
  let openH = null;
  gates.set('g', new Promise((resolve) => (openG = resolve)));
  gates.set('h', new Promise((resolve) => (openH = resolve)));
  const g = builds.submit('g', 'g'.repeat(10), 'g', await builds.admit(10), {});
  const h = builds.submit('h', 'h'.repeat(10), 'h', await builds.admit(10), {});
  const next = builds.submit('s', 'b'.repeat(10), 'b', await builds.admit(10), {});
  // g's base evicts s's first base while s's next version is still queued.
  openG();
  await g;
  await nextTurn();
  gc();
  assert.equal(firstMessages.deref(), undefined, 'the evicted base was collected');
  openH();
  await h;
  await next;
  assert.deepEqual(previousSeen.slice(1), [null], 'the next version started without it');
});

test('parsed-prefix reuse compares exact JSON values, key order included', () => {
  assert.equal(sameJsonValue({ a: 1, b: [1, { c: 'x' }] }, { a: 1, b: [1, { c: 'x' }] }), true);
  assert.equal(sameJsonValue({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  assert.equal(sameJsonValue([1, 2], [1, 2, 3]), false);
  assert.equal(sameJsonValue({ a: [] }, { a: {} }), false);
  assert.equal(sameJsonValue({ a: null }, { a: {} }), false);
  assert.equal(sameJsonValue(0, -0), false);
  const previous = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ];
  const next = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'B' },
    { role: 'user', content: 'c' },
  ];
  assert.equal(reuseParsedPrefix(next, previous), 1);
  assert.equal(next[0], previous[0]);
  assert.notEqual(next[2], previous[2], 'reuse stops at the first difference');
  assert.equal(reuseParsedPrefix(next, null), 0);
});
