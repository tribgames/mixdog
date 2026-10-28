import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_TRANSCRIPT_PAGE_BYTES,
  REMOTE_TRANSCRIPT_TAIL_BYTES,
  REMOTE_TRANSCRIPT_TAIL_ITEMS,
} from './desktop-support.ts';
import { archiveItemsForCompaction } from '../../../../src/tui/session/compaction-view.mjs';
import { createTranscriptSpillBuffer } from '../../../../src/tui/session/transcript-spill.mjs';
import {
  loadLiveTranscriptHead,
  requestLiveTranscriptWindow,
  windowTranscriptSnapshot,
} from '../../../../src/standalone/session-service/projection/transcript-window.mjs';
import { REMOTE_HISTORY_OUTPUT_CHARS, remoteToolOutput } from './remote-transcript.ts';
import { encodePhoneSessionState, requestPhoneTranscriptPage } from './remote-transcript-window.ts';
import { viewIsStale } from './remote-view-staleness.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } from './state-delta.ts';

/** One phone: its encoder, its decoder, and what it holds after each frame. */
function phone() {
  const encoder = createSnapshotDeltaEncoder({ prepend: true });
  const decoder = createSnapshotDeltaDecoder();
  let held = null;
  return {
    encoder,
    deliver(snapshot) {
      const wire = encodePhoneSessionState(encoder, snapshot, true);
      const text = JSON.stringify(wire);
      const decoded = decoder.decode(JSON.parse(text));
      assert.equal(decoded.ok, true);
      held = decoded.snapshot;
      return { snapshot: held, bytes: Buffer.byteLength(text) };
    },
    get held() {
      return held;
    },
  };
}
const itemBytes = (items) => items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
const user = (id, chars) => ({ id, kind: 'user', text: `${id} ${'w'.repeat(chars)}` });
const shell = (id, chars) => ({
  id,
  kind: 'tool',
  name: 'shell',
  args: { command: 'npm test' },
  result: `${id}\n${'o'.repeat(chars)}`,
  completedAt: 1,
});

test('a page revealed above a short first page arrives as history, the rows the phone opened on stay its tail', () => {
  // The review's repro: a byte-budgeted first page of 8 rows, then 8 paged rows.
  const held = Array.from({ length: 8 }, (_, n) => shell(`t${n}`, 1_500));
  const paged = Array.from({ length: 8 }, (_, n) => shell(`h${n}`, 1_500));
  const reader = phone();
  const opened = reader.deliver({ items: held, transcriptHasOlder: true }).snapshot;
  assert.deepEqual(
    opened.items.map((item) => item.result),
    held.map((item) => item.result),
    'the first page is tail'
  );
  requestPhoneTranscriptPage(reader.encoder, 8 + 64);
  const { snapshot } = reader.deliver({ items: [...paged, ...held], transcriptHasOlder: false });
  assert.equal(snapshot.items.length, 16);
  for (const [index, row] of paged.entries()) {
    assert.ok(snapshot.items[index].result.length <= REMOTE_HISTORY_OUTPUT_CHARS, `${row.id}: cut as history`);
    assert.ok(snapshot.items[index].remoteOutputTruncated > 0);
  }
  for (const [index, row] of held.entries()) {
    assert.equal(snapshot.items[8 + index].result, row.result, `${row.id}: still the copy it opened with`);
  }
});

test("a phone's first page stays within its byte budget however wide the shared window is", () => {
  // A desktop pane shares the session: the host reads its 32-row / 1 MB window.
  const shared = Array.from({ length: 32 }, (_, n) => user(`u${n}`, 20_000));
  const reader = phone();
  const { snapshot } = reader.deliver({ items: shared, transcriptHasOlder: true });
  assert.ok(itemBytes(snapshot.items) <= REMOTE_TRANSCRIPT_TAIL_BYTES, `${itemBytes(snapshot.items)} bytes of rows`);
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    shared.slice(-snapshot.items.length).map((item) => item.id),
    'the newest rows'
  );
  assert.equal(snapshot.transcriptHasOlder, true);
  // The review's repro: the daemon's 8-row floor of 20,000-character rows.
  const floor = phone().deliver({ items: shared.slice(-8), transcriptHasOlder: true }).snapshot;
  assert.ok(itemBytes(floor.items) <= REMOTE_TRANSCRIPT_TAIL_BYTES);
  assert.ok(floor.items.length < 8 && floor.transcriptHasOlder === true);
  // Short rows still open on the remote tail's row count.
  const short = Array.from({ length: 32 }, (_, n) => user(`s${n}`, 10));
  assert.equal(phone().deliver({ items: short }).snapshot.items.length, REMOTE_TRANSCRIPT_TAIL_ITEMS);
});

test('live rows append past the first page; older rows reveal only on the phone request, within the page', () => {
  const rows = Array.from({ length: 40 }, (_, n) => user(`r${n}`, 10));
  const reader = phone();
  reader.deliver({ items: rows, transcriptHasOlder: false });
  const live = [...rows, user('live', 10)];
  const { snapshot } = reader.deliver({ items: live, transcriptHasOlder: false });
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    live.slice(-REMOTE_TRANSCRIPT_TAIL_ITEMS - 1).map((item) => item.id),
    'no unrequested reveal'
  );
  requestPhoneTranscriptPage(reader.encoder, REMOTE_TRANSCRIPT_TAIL_ITEMS + 1 + 5);
  const paged = reader.deliver({ items: live, transcriptHasOlder: false }).snapshot;
  assert.equal(paged.items.length, REMOTE_TRANSCRIPT_TAIL_ITEMS + 1 + 5);
  assert.equal(paged.transcriptHasOlder, true);
  // A desktop prompt above the phone's window is not one it missed.
  const latest = [{ ...rows[0], device: 'desktop' }, ...live.slice(1)];
  assert.equal(viewIsStale(paged.items, latest, 'phone'), false);
  assert.equal(viewIsStale(paged.items, [...latest, { id: 'new', kind: 'user', device: 'desktop' }], 'phone'), true);
});

test('a phone page reveals at most 512 rows a request, whatever limit it names, and pages on to the first row', () => {
  const rows = Array.from({ length: 2_000 }, (_, n) => user(`d${n}`, 10));
  const reader = phone();
  let held = reader.deliver({ items: rows, transcriptHasOlder: false }).snapshot.items.length;
  const counts = [];
  while (held < rows.length) {
    requestPhoneTranscriptPage(reader.encoder, 10_000_000);
    const { snapshot } = reader.deliver({ items: rows, transcriptHasOlder: false });
    assert.ok(snapshot.items.length - held <= 512, `revealed ${snapshot.items.length - held}`);
    held = snapshot.items.length;
    counts.push(held);
  }
  assert.deepEqual(counts, [532, 1_044, 1_556, 2_000]);
  assert.equal(reader.held.items[0].id, 'd0');
  assert.equal(reader.held.transcriptHasOlder, false);
});

test('an oversized newest tool row goes with its outputs cut to fit, readable whole through Show full output', () => {
  const members = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}`, name: 'read', result: 'r'.repeat(8_000) }));
  const aggregate = { id: 'agg', kind: 'tool', aggregate: true, result: '', toolMembers: members, completedAt: 1 };
  const { snapshot } = phone().deliver({ items: [user('old', 10), aggregate], transcriptHasOlder: false });
  const [sent] = snapshot.items;
  assert.equal(snapshot.items.length, 1, 'the newest row alone');
  assert.ok(itemBytes([sent]) <= REMOTE_TRANSCRIPT_TAIL_BYTES, `${itemBytes([sent])} bytes`);
  for (const [index, record] of sent.toolMembers.entries()) {
    const note = record.remoteOutputNotes?.result;
    assert.equal(note?.kind, 'omitted', `${record.id}: noted`);
    assert.equal(note.at, record.result.length);
    assert.ok(record.remoteOutputTruncated > record.result.length, `${record.id}: offers Show full output`);
    assert.equal(remoteToolOutput({ items: [aggregate] }, record.id).result, members[index].result, 'read back whole');
  }
});

test('a compacted live session whose runtime spilled rows pages back on the phone to its first row', async (t) => {
  // 700 rows, a live compaction after row 400, the runtime's real memory cap.
  const spill = createTranscriptSpillBuffer({
    workerFactory: () => ({ on() {}, postMessage() {}, terminate() {}, unref() {} }),
  });
  t.after(() => spill.dispose());
  const row = (n) => user(`it_${n}`, 200);
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
  const state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: spill.spilled };
  assert.equal(items[0].id, 'it_256');
  const entry = {
    runtime: { getState: () => state, readSpilledTranscript: (range) => spill.readSpilled(range) },
    transcriptView: null,
    publishedSnapshot: null,
  };
  // The host's shared window, as a phone-only session opens it.
  requestLiveTranscriptWindow(entry, {
    limit: REMOTE_TRANSCRIPT_TAIL_ITEMS,
    byteBudget: REMOTE_TRANSCRIPT_TAIL_BYTES,
    pageBase: 0,
  });
  let host = windowTranscriptSnapshot(entry, state);
  const reader = phone();
  let held = reader.deliver(host).snapshot;
  for (let step = 0; held.transcriptHasOlder && step < 100; step += 1) {
    // The renderer asks one page above what it holds; the host grows the
    // shared window when the page reaches past it.
    const limit = held.items.length + 64;
    requestPhoneTranscriptPage(reader.encoder, limit);
    if (limit > host.items.length) {
      requestLiveTranscriptWindow(entry, {
        limit,
        byteBudget: DESKTOP_TRANSCRIPT_PAGE_BYTES,
        pageBase: host.items.length,
      });
      await loadLiveTranscriptHead(entry, 's', async () => null);
      host = windowTranscriptSnapshot(entry, state);
    }
    held = reader.deliver(host).snapshot;
  }
  assert.deepEqual(
    held.items.map((item) => item.id),
    all.map((item) => item.id)
  );
  assert.equal(held.items[0].id, 'it_0');
  assert.equal(held.transcriptHasOlder, false);
});

test('an oversized message row is sent whole, so a first page with it is over the budget (as HEAD)', () => {
  const message = user('big', 400_000);
  const { snapshot } = phone().deliver({ items: [user('old', 10), message], transcriptHasOlder: false });
  assert.deepEqual(snapshot.items, [message], 'the newest row alone, its text whole');
  assert.ok(itemBytes(snapshot.items) > REMOTE_TRANSCRIPT_TAIL_BYTES);
  assert.equal(snapshot.transcriptHasOlder, true);
});
