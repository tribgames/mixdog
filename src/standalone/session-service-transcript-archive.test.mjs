// A live view pages past the runtime's first row into the display-only
// compaction archive: after a live compaction (rows archived in memory) only
// archive pages; after a resume, durable history that continues into it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionArchivePageFromText } from '../runtime/agent/orchestrator/session/compaction-archive.mjs';
import {
  compactionArchiveProjection,
  compactionSegmentItems,
} from '../runtime/agent/orchestrator/session/compaction-archive-capture.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import {
  loadLiveTranscriptHead,
  requestLiveTranscriptWindow,
  windowTranscriptSnapshot,
} from './session-service/projection/transcript-window.mjs';

const segmentLine = (seq, count) =>
  JSON.stringify({
    v: 1,
    seq,
    id: `seg${seq}`,
    prev: seq > 1 ? `seg${seq - 1}` : null,
    at: seq,
    count: count + 1,
    bytes: 0,
    items: [
      ...Array.from({ length: count }, (_, index) => ({
        id: `arch${seq}_${index}_1`,
        kind: 'assistant',
        text: `s${seq} ${index}`,
        archived: true,
      })),
      { id: `arch${seq}_divider`, kind: 'statusdone', status: 'compacted', label: 'Conversation compacted' },
    ],
  });
const ARCHIVE = `${segmentLine(1, 3)}\n${segmentLine(2, 3)}\n`;

function liveEntry(state) {
  return { runtime: { getState: () => state }, transcriptView: null, publishedSnapshot: null };
}

const ids = (wire) => wire.items.map((item) => item.id);

test('after a live compaction the head pages the archive segments the runtime holds none of', async () => {
  const state = {
    sessionId: 'sess_archive_live',
    items: [
      { id: 'hist_sess_archive_live_4_1', kind: 'user', text: 'kept old', archived: true },
      { id: 'it_9', kind: 'statusdone', status: 'compacted', label: 'Compact complete' },
      { id: 'it_10', kind: 'user', text: 'new' },
    ],
    // Resumed with segments 1-2 archived; segment 3 is the live compaction.
    transcriptArchive: { after: 0, before: 3 },
  };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: null, pageBase: 0 });
  assert.equal(windowTranscriptSnapshot(entry, state).transcriptHasOlder, true);
  const reads = [];
  const readStoredSession = async (_sessionId, options) => {
    reads.push(options);
    return compactionArchivePageFromText(ARCHIVE, options.compactionArchive);
  };
  requestLiveTranscriptWindow(entry, { limit: 37, byteBudget: null, pageBase: 3 });
  assert.equal(await loadLiveTranscriptHead(entry, 'sess_archive_live', readStoredSession), true);
  assert.deepEqual(reads, [{ compactionArchive: { after: 0, before: 3, skip: 0, limit: 34 }, paging: true }]);
  let wire = windowTranscriptSnapshot(entry, state);
  assert.deepEqual(ids(wire).slice(0, 8), [
    'arch1_0_1',
    'arch1_1_1',
    'arch1_2_1',
    'arch1_divider',
    'arch2_0_1',
    'arch2_1_1',
    'arch2_2_1',
    'arch2_divider',
  ]);
  assert.equal(wire.transcriptHasOlder, false);
  assert.equal(await loadLiveTranscriptHead(entry, 'sess_archive_live', readStoredSession), false);
  wire = windowTranscriptSnapshot(entry, state);
  assert.equal(wire.items.length, 11);
});

test('archive pages continue below the rows already loaded', async () => {
  const state = {
    sessionId: 'sess_archive_pages',
    items: [{ id: 'it_1', kind: 'user', text: 'new' }],
    transcriptArchive: { after: 0, before: 3 },
  };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 1, byteBudget: null, pageBase: 0 });
  windowTranscriptSnapshot(entry, state);
  const readStoredSession = async (_sessionId, options) =>
    compactionArchivePageFromText(ARCHIVE, options.compactionArchive);
  requestLiveTranscriptWindow(entry, { limit: 4, byteBudget: null, pageBase: 1 });
  await loadLiveTranscriptHead(entry, 'sess_archive_pages', readStoredSession);
  let wire = windowTranscriptSnapshot(entry, state);
  assert.deepEqual(ids(wire), ['arch2_1_1', 'arch2_2_1', 'arch2_divider', 'it_1']);
  assert.equal(wire.transcriptHasOlder, true);
  requestLiveTranscriptWindow(entry, { limit: 8, byteBudget: null, pageBase: 4 });
  await loadLiveTranscriptHead(entry, 'sess_archive_pages', readStoredSession);
  wire = windowTranscriptSnapshot(entry, state);
  assert.deepEqual(ids(wire), [
    'arch1_1_1',
    'arch1_2_1',
    'arch1_divider',
    'arch2_0_1',
    'arch2_1_1',
    'arch2_2_1',
    'arch2_divider',
    'it_1',
  ]);
  assert.equal(wire.transcriptHasOlder, true);
});

test('a resumed runtime whose rows start at message 0 pages durable history that continues into the archive', async () => {
  const sessionId = 'sess_archive_resumed';
  const restored = [
    { id: `hist_${sessionId}_0_1`, kind: 'user', text: 'after compaction' },
    { id: `hist_${sessionId}_1_1`, kind: 'assistant', text: 'reply' },
  ];
  const state = { sessionId, items: restored, transcriptArchive: { after: 0, before: 3 } };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 2, byteBudget: null, pageBase: 0 });
  windowTranscriptSnapshot(entry, state);
  const archived = (await compactionArchivePageFromText(ARCHIVE, { limit: 8 })).items;
  const reads = [];
  const readStoredSession = async (_sessionId, options) => {
    reads.push(options);
    return { items: [...archived, ...restored], transcriptHasOlder: false };
  };
  requestLiveTranscriptWindow(entry, { limit: 10, byteBudget: null, pageBase: 2 });
  await loadLiveTranscriptHead(entry, sessionId, readStoredSession);
  assert.deepEqual(reads, [{ transcriptItemLimit: 12, paging: true }]);
  const wire = windowTranscriptSnapshot(entry, state);
  assert.deepEqual(ids(wire), [...archived.map((item) => item.id), ...restored.map((item) => item.id)]);
  assert.equal(wire.transcriptHasOlder, false);
});

test('a bounded resumed window whose first row is archived by compaction, with no archive, still pages older rows', async () => {
  const sessionId = 'sess_no_archive';
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `m${index}`,
    meta: { transcript: { messageId: `msg_${index}` } },
  }));
  // Resume restored only the tail (messages 2..9); then a compaction moved
  // messages 0..5 out of the context into the display-only archive.
  const tail = restoreTranscriptItems(messages, { sessionId }).slice(2);
  const state = {
    sessionId,
    items: [
      ...tail.slice(0, 4).map((item) => ({ ...item, archived: true })),
      { id: 'it_c', kind: 'statusdone', status: 'compacted', label: 'Compact complete' },
      ...tail.slice(4),
    ],
    transcriptArchive: null,
  };
  assert.equal(state.items[0].id, `hist_${sessionId}_2_1`);
  // Durable side, built by the production functions: the archive segment of
  // the dropped messages, then the post-compaction record's restored rows.
  const segment = compactionSegmentItems(messages.slice(0, 6), { sessionId, seq: 1, at: 1 });
  const record = restoreTranscriptItems(messages.slice(6), { sessionId });
  const stored = [...segment, ...record];
  assert.notEqual(segment[2].id, state.items[0].id);
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: null, pageBase: 0 });
  assert.equal(windowTranscriptSnapshot(entry, state).transcriptHasOlder, true);
  const readStoredSession = async () => ({ items: stored, transcriptHasOlder: false });
  requestLiveTranscriptWindow(entry, { limit: 40, byteBudget: null, pageBase: 32 });
  assert.equal(await loadLiveTranscriptHead(entry, sessionId, readStoredSession), true);
  const wire = windowTranscriptSnapshot(entry, state);
  assert.deepEqual(ids(wire), [segment[0].id, segment[1].id, ...state.items.map((item) => item.id)]);
  assert.equal(wire.items[0].archived, true);
  assert.equal(wire.transcriptHasOlder, false);
});

test('a tool-row anchor pages older rows although a retained system message shifts archive indices', async () => {
  const sessionId = 'review_tool';
  const stamp = (message, index) => ({ ...message, meta: { transcript: { messageId: `msg_${index}` } } });
  const before = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'run it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'kept question' },
    { role: 'assistant', content: 'kept answer' },
  ].map(stamp);
  const after = [before[0], before[7], before[8]];
  const projection = compactionArchiveProjection(before, after);
  assert.equal(projection.messages.includes(before[0]), false);
  const segment = compactionSegmentItems(projection.messages, { sessionId, seq: 1, at: 1 });
  const record = restoreTranscriptItems(after, { sessionId });
  const stored = [...segment, ...record];
  // Live rows: the resumed tail starts at the tool card, archived by compaction.
  const all = restoreTranscriptItems(before, { sessionId });
  const toolAt = all.findIndex((item) => item.kind === 'tool');
  assert.ok(toolAt > 0);
  const live = all.slice(toolAt).map((item, index) => (index < 2 ? { ...item, archived: true } : item));
  const anchor = live[0];
  assert.equal(anchor.messageId, undefined);
  const archivedTool = segment.find((item) => item.kind === 'tool');
  assert.notEqual(anchor.id.replace(`hist_${sessionId}_`, ''), archivedTool.id.replace('arch1_', ''));
  const state = { sessionId, items: live, transcriptArchive: null };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: null, pageBase: 0 });
  assert.equal(windowTranscriptSnapshot(entry, state).transcriptHasOlder, true);
  requestLiveTranscriptWindow(entry, { limit: 40, byteBudget: null, pageBase: 32 });
  assert.equal(
    await loadLiveTranscriptHead(entry, sessionId, async () => ({ items: stored, transcriptHasOlder: false })),
    true
  );
  const wire = windowTranscriptSnapshot(entry, state);
  const olderIds = segment.slice(0, segment.indexOf(archivedTool)).map((item) => item.id);
  assert.ok(olderIds.length > 0);
  assert.deepEqual(ids(wire), [...olderIds, ...live.map((item) => item.id)]);
  assert.equal(wire.transcriptHasOlder, false);
});

// Pages the head of a live runtime whose durable history is `stored`; returns
// the windowed wire after the load.
async function pageHead(sessionId, items, stored) {
  const state = { sessionId, items, transcriptArchive: null };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: null, pageBase: 0 });
  windowTranscriptSnapshot(entry, state);
  requestLiveTranscriptWindow(entry, { limit: 40, byteBudget: null, pageBase: 32 });
  await loadLiveTranscriptHead(entry, sessionId, async () => ({ items: stored, transcriptHasOlder: false }));
  return windowTranscriptSnapshot(entry, state);
}

const stampIds = (messages) =>
  messages.map((message, index) => ({
    ...message,
    meta: { ...message.meta, transcript: { ...message.meta?.transcript, messageId: `msg_${index}` } },
  }));
const divider = { id: 'it_div', kind: 'statusdone', status: 'compacted', label: 'Compact complete' };

test('an archive aggregate that merges a call the live window lacks is never joined (c1 is not dropped)', async () => {
  const sessionId = 'partial_agg';
  const call = (id) => ({ id, type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } });
  const before = stampIds([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: 'one' },
    { role: 'assistant', content: '', tool_calls: [call('c2')] },
    { role: 'tool', tool_call_id: 'c2', content: 'two' },
    { role: 'user', content: 'kept' },
  ]);
  const after = [before[5]];
  const segment = compactionSegmentItems(compactionArchiveProjection(before, after).messages, {
    sessionId,
    seq: 1,
    at: 1,
  });
  const aggregate = segment.find((item) => item.kind === 'tool');
  assert.deepEqual(aggregate.callIds, ['c1', 'c2']);
  const stored = [...segment, ...restoreTranscriptItems(after, { sessionId })];
  // Live shows the calls separately; only c2 is loaded (c1 is above the window).
  const [c2] = restoreTranscriptItems([before[3], before[4]], { sessionId });
  const live = [{ ...c2, id: `hist_${sessionId}_3_1`, archived: true }, divider];
  const wire = await pageHead(sessionId, live, stored);
  assert.equal(
    wire.items.some((item) => item.id === aggregate.id),
    false
  );
  assert.deepEqual(
    ids(wire),
    live.map((item) => item.id)
  );
  assert.equal(wire.transcriptHasOlder, false);
});

test('an identity-less archived anchor never joins a post-compaction row sharing its restore id', async () => {
  const sessionId = 'collision';
  const inherited = { sessionId: 'prev', provider: 'p', modelId: 'm', at: 1 };
  const before = stampIds([
    { role: 'user', content: 'old' },
    { role: 'user', content: 'old again', meta: { sessionInheritances: [inherited] } },
  ]);
  const after = stampIds([
    { role: 'user', content: 'summary' },
    { role: 'user', content: 'current prompt', meta: { sessionInheritances: [inherited] } },
  ]).map((message, index) => ({ ...message, meta: { ...message.meta, transcript: { messageId: `new_${index}` } } }));
  const segment = compactionSegmentItems(compactionArchiveProjection(before, after).messages, {
    sessionId,
    seq: 1,
    at: 1,
  });
  const record = restoreTranscriptItems(after, { sessionId });
  const oldMarker = restoreTranscriptItems(before, { sessionId }).find((item) => item.status === 'inherited');
  const newMarker = record.find((item) => item.status === 'inherited');
  assert.equal(oldMarker.id, newMarker.id);
  const live = [{ ...oldMarker, archived: true }, divider, { id: 'it_p', kind: 'user', text: 'current prompt' }];
  const wire = await pageHead(sessionId, live, [...segment, ...record]);
  assert.deepEqual(
    ids(wire),
    live.map((item) => item.id)
  );
  assert.equal(wire.items.filter((item) => item.text === 'current prompt').length, 1);
  assert.equal(wire.transcriptHasOlder, false);
});

test('retained rows renumbered by the compaction join by messageId, never by their old restore id', async () => {
  const sessionId = 'renumbered';
  const before = stampIds([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'dropped question' },
    { role: 'assistant', content: 'dropped answer' },
    { role: 'user', content: 'kept question' },
    { role: 'assistant', content: 'kept answer' },
  ]);
  const later = stampIds([...before, { role: 'user', content: 'unrelated' }, { role: 'assistant', content: 'reply' }]);
  const after = [later[0], later[3], later[4], later[5], later[6]];
  const segment = compactionSegmentItems(compactionArchiveProjection(later, after).messages, {
    sessionId,
    seq: 1,
    at: 1,
  });
  const record = restoreTranscriptItems(after, { sessionId });
  const liveRows = restoreTranscriptItems(later, { sessionId }).slice(2);
  const anchor = liveRows[0];
  assert.equal(anchor.text, 'kept question');
  // The retained row's old id now names an unrelated row in the record.
  const clash = record.find((item) => item.id === anchor.id);
  assert.ok(clash && clash.text !== anchor.text);
  const live = [anchor, liveRows[1], divider];
  const wire = await pageHead(sessionId, live, [...segment, ...record]);
  const olderIds = ids(wire).slice(0, -live.length);
  assert.deepEqual(
    olderIds,
    segment.map((item) => item.id)
  );
  assert.deepEqual(
    ids(wire).slice(-live.length),
    live.map((item) => item.id)
  );
  assert.equal(wire.transcriptHasOlder, false);
});

test('a verified anchor whose older prefix repeats an archived live row is never joined', async () => {
  const sessionId = 'dup_prefix';
  const before = stampIds([
    { role: 'user', content: 'dropped prompt' },
    { role: 'user', content: 'retained prompt' },
    { role: 'assistant', content: 'archived reply' },
    { role: 'user', content: 'current prompt' },
  ]);
  const after = [before[1], before[3]];
  const segment = compactionSegmentItems(compactionArchiveProjection(before, after).messages, {
    sessionId,
    seq: 1,
    at: 1,
  });
  const stored = [...segment, ...restoreTranscriptItems(after, { sessionId })];
  assert.ok(stored.some((item) => item.text === 'archived reply'));
  // Resumed tail: the first message is not loaded.
  const [retained, reply, current] = restoreTranscriptItems(before, { sessionId }).slice(1);
  const live = [retained, { ...reply, archived: true }, current];
  const wire = await pageHead(sessionId, live, stored);
  assert.deepEqual(
    ids(wire),
    live.map((item) => item.id)
  );
  assert.equal(wire.items.filter((item) => item.text === 'archived reply').length, 1);
  assert.equal(wire.transcriptHasOlder, false);
});

test('a durable head loaded before a compaction is kept as is, and paging stops after it', async () => {
  const sessionId = 'stale_head';
  const turn = (index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` });
  const messages = stampIds(Array.from({ length: 12 }, (_, index) => turn(index)));
  const first10 = messages.slice(0, 10);
  const liveRows = restoreTranscriptItems(first10, { sessionId }).slice(8);
  const state = { sessionId, items: liveRows, transcriptArchive: null };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 2, byteBudget: null, pageBase: 0 });
  windowTranscriptSnapshot(entry, state);
  // Page in m6, m7 from durable history before any compaction.
  requestLiveTranscriptWindow(entry, { limit: 4, byteBudget: null, pageBase: 2 });
  windowTranscriptSnapshot(entry, state);
  const firstStored = restoreTranscriptItems(first10, { sessionId });
  assert.equal(
    await loadLiveTranscriptHead(entry, sessionId, async () => ({ items: firstStored, transcriptHasOlder: true })),
    true
  );
  const head = windowTranscriptSnapshot(entry, state);
  assert.deepEqual(
    ids(head),
    firstStored.slice(6).map((item) => item.id)
  );
  // Compaction drops m0..m4 and renumbers the record; m10, m11 arrive after it.
  const after = messages.slice(5);
  const segment = compactionSegmentItems(compactionArchiveProjection(messages, after).messages, {
    sessionId,
    seq: 1,
    at: 1,
  });
  const record = restoreTranscriptItems(after, { sessionId });
  assert.equal(record.find((item) => item.id === `hist_${sessionId}_6_1`).text, 'm11');
  state.items = [
    ...liveRows,
    divider,
    { id: 'it_10', kind: 'user', text: 'm10' },
    { id: 'it_11', kind: 'assistant', text: 'm11' },
  ];
  requestLiveTranscriptWindow(entry, { limit: 16, byteBudget: null, pageBase: 8 });
  windowTranscriptSnapshot(entry, state);
  await loadLiveTranscriptHead(entry, sessionId, async () => ({
    items: [...segment, ...record],
    transcriptHasOlder: false,
  }));
  const wire = windowTranscriptSnapshot(entry, state);
  const expected = [...firstStored.slice(6, 8), ...state.items].map((item) => item.id);
  assert.deepEqual(ids(wire), expected);
  assert.equal(new Set(ids(wire)).size, ids(wire).length);
  assert.equal(wire.items.filter((item) => item.text === 'm11').length, 1);
  assert.equal(wire.transcriptHasOlder, false);
});

test('a runtime with no archive and rows from message 0 has nothing older', () => {
  const state = { sessionId: 's', items: [{ id: 'hist_s_0_1', kind: 'user', text: 'hi' }], transcriptArchive: null };
  const entry = liveEntry(state);
  requestLiveTranscriptWindow(entry, { limit: 32, byteBudget: null, pageBase: 0 });
  assert.equal(windowTranscriptSnapshot(entry, state).transcriptHasOlder, false);
});
