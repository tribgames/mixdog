// A positioned subscription's window: the fold of its snapshot, units and window changes, the moves a reader asks the core
// for, and the client that sends them over the mock transport. Inputs are inline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { desktopSessionState, sessionReducer, sessionStateOf } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';
import { moveTranscriptWindow, windowWant, WINDOW_TAIL_MAX_ROWS } from '../src/transcript-window.ts';

type O = Record<string, any>;
const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

const pos = (id: string) => `h1:0:${id}`;
const user = (id: string, text = id) => ({
  type: 'userMessage',
  id,
  content: [{ type: 'text', text }],
  meta: { ext: { historyPosition: pos(id) } },
});
const reply = (id: string, text = id) => ({ type: 'agentMessage', id, text, meta: { ext: { historyPosition: pos(id) } } });
const unit = (item: O) => ({ position: pos(item.id), items: [item] });
const units = (ids: string[]) => ids.map((id, at) => unit(at % 2 ? reply(id) : user(id)));
const cont = (position: string) => ({ kind: 'continuation', position });
const end = { kind: 'end' };
const at = (s: SessionFold, method: string, params: O) =>
  sessionReducer.apply(s, { method, params: { threadId: 't', ...params } } as never);
const ids = (rows: readonly O[]) => rows.map((row) => row.id);
const snapshot = (tail: string[], loose: O[] = [], older = true) =>
  sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: loose,
    hasOlder: older,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: older ? cont(pos(tail[0]!)) : end, newer: end }],
      added: [{ range: 'tail', units: units(tail) }],
      followTail: true,
    },
  } as unknown as Json);
const state = (s: SessionFold) => desktopSessionState(s, []) as O;

test('a positioned snapshot shows the tail records it carries, then the rows no record holds yet', () => {
  const s = snapshot(['r5', 'r6', 'r7'], [{ type: 'agentMessage', id: 'live', text: 'working', meta: {} }]);
  assert.deepEqual(ids(s.items), ['r5', 'r6', 'r7', 'live']);
  const shown = state(s);
  assert.equal(shown.transcriptPositioned, true);
  assert.equal(shown.transcriptHistory, 'older');
  assert.equal(shown.transcriptHasOlder, true);
  assert.equal(shown.transcriptWindowStart, pos('r5'));
  assert.equal(shown.transcriptViewItems, null);
});

test('a stored record joins the followed tail and takes the place of the rows shown for it', () => {
  let s = snapshot(['r1', 'r2']);
  s = at(s, 'item/started', { turnId: 'x', item: { type: 'agentMessage', id: 'r3', text: '', meta: { status: 'inProgress' } } });
  s = at(s, 'item/agentMessage/delta', { itemId: 'r3', delta: 'stream' });
  // The record's own `item/completed` reaches a positioned subscription as a change with no row.
  s = at(s, 'thread/transcript/changed', { lineage: 1 });
  s = at(s, 'turn/completed', { turnId: 'x' });
  // The reply stays shown, settled, until its record arrives.
  assert.deepEqual(
    s.items.map((row) => [row.id, row.text]),
    [
      ['r1', 'r1'],
      ['r2', 'r2'],
      ['r3', 'stream'],
    ]
  );
  const frames = s.frames ?? 0;
  s = at(s, 'thread/transcript/changed', {
    lineage: 1,
    change: { op: 'insert', after: pos('r2'), unit: unit(reply('r3', 'stored')) },
    atFeedPosition: { epoch: 'e', seq: 4 },
  });
  assert.deepEqual(
    s.items.map((row) => [row.id, row.text]),
    [
      ['r1', 'r1'],
      ['r2', 'r2'],
      ['r3', 'stored'],
    ]
  );
  assert.equal(s.frames, frames + 1, 'a unit is a publication of its own');
  // Another lineage's change, and a replace of a record not held, change nothing.
  assert.equal(at(s, 'thread/transcript/changed', { lineage: 2, change: { op: 'replace', unit: unit(reply('r3', 'x')) } }), s);
  assert.equal(at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: unit(reply('r9')) } }), s);
  s = at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: unit(reply('r2', 'amended')) } });
  assert.equal(s.items[1]!.text, 'amended');
});

test('a page read above the tail joins it; letting go of the rows next to the tail shows the reader a stretch of its own', () => {
  let s = snapshot(['r20', 'r21']);
  s = at(s, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: 'q1',
    windowVersion: 11,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: 3 },
    ranges: [
      { id: 'tail', older: cont(pos('r20')), newer: end },
      { id: 'q:q1:0', older: cont(pos('r17')), newer: cont(pos('r20')) },
    ],
    removed: [],
    added: [{ range: 'q:q1:0', units: units(['r17', 'r18', 'r19', 'r20']) }],
    followTail: true,
  });
  assert.deepEqual(ids(s.items), ['r17', 'r18', 'r19', 'r20', 'r21']);
  assert.equal(state(s).transcriptViewItems, null);
  s = at(s, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: 'q2',
    windowVersion: 12,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: 3 },
    ranges: [
      { id: 'tail', older: cont(pos('r20')), newer: end },
      { id: 'q:q2:0', older: cont(pos('r14')), newer: cont(pos('r17')) },
    ],
    removed: ['q:q1:0'],
    added: [{ range: 'q:q2:0', units: units(['r14', 'r15', 'r16', 'r17']) }],
    followTail: true,
  });
  assert.deepEqual(ids(s.items), ['r20', 'r21']);
  const shown = state(s);
  assert.deepEqual(ids(shown.transcriptViewItems), ['r14', 'r15', 'r16', 'r17']);
  assert.deepEqual([shown.transcriptHistoryBefore, shown.transcriptHistoryAfter], [true, true]);
  assert.deepEqual([...s.held!.units.keys()].sort(), ['r14', 'r15', 'r16', 'r17', 'r20', 'r21'].map(pos).sort());
  // The same stretch reads as the same rows while a change elsewhere lands.
  const after = at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'insert', unit: unit(user('r22')) } });
  assert.equal(state(after).transcriptViewItems, shown.transcriptViewItems);
});

test('a rewind cuts what follows its boundary and a clear leaves nothing', () => {
  let s = snapshot(['r1', 'r2', 'r3', 'r4']);
  s = at(s, 'thread/historyReset', { reason: 'rewind', fromItemId: 'r2', hasOlder: true });
  assert.deepEqual(ids(s.items), ['r1', 'r2']);
  assert.equal(s.generation, 1);
  s = at(s, 'thread/historyReset', { reason: 'clear', hasOlder: false });
  assert.deepEqual(ids(s.items), []);
  assert.equal(s.held!.units.size, 0);
});

test('the moves a reader asks for: a page above, a bounded stretch, the tail read anew, a hit opened', () => {
  const s = snapshot(['r20', 'r21']);
  assert.deepEqual(windowWant(s.held!, { kind: 'older' }), {
    ranges: [{ at: 'retain', id: 'tail' }, { at: 'before', position: pos('r20'), rows: 96 }],
    followTail: true,
    pinned: [],
  });
  assert.equal(windowWant(s.held!, { kind: 'follow' }), null, 'the followed tail alone is what following holds');
  assert.equal(windowWant(s.held!, { kind: 'newer' }), null);
  assert.equal(windowWant(s.held!, { kind: 'at', position: pos('r21') }), null);
  assert.deepEqual(windowWant(s.held!, { kind: 'at', position: pos('r3') })?.ranges, [
    { at: 'retain', id: 'tail' },
    { at: 'around', position: pos('r3'), before: 96, after: 96 },
  ]);
  // A tail grown past its bound is read anew when the reader follows it.
  const grown = snapshot(Array.from({ length: WINDOW_TAIL_MAX_ROWS + 1 }, (_, i) => `g${i}`));
  assert.deepEqual(windowWant(grown.held!, { kind: 'follow' }), { ranges: [], followTail: true, pinned: [] });
  // Pages above the tail, beyond the reader's bound, let go of those next to the tail first.
  let paged = snapshot(['p999']);
  let next = 1000;
  const chunks: string[] = [];
  for (let page = 0; page < 6; page++) {
    const first = paged.held!.ranges.flatMap((range) => range.positions).sort()[0]!;
    const id = `q:${page}`;
    const rows = Array.from({ length: 96 }, () => `p${--next - 1}`).reverse();
    chunks.push(id);
    paged = at(paged, 'thread/window/changed', {
      windowVersion: 20 + page,
      lineage: 1,
      ranges: [
        ...paged.held!.ranges.map((range) => ({ id: range.id, older: cont(range.positions[0]!), newer: end })),
        { id, older: cont(pos(rows[0]!)), newer: cont(first) },
      ],
      removed: [],
      added: [{ range: id, units: units([...rows, first.slice(5)]) }],
      followTail: true,
    });
  }
  const want = windowWant(paged.held!, { kind: 'older' })!;
  const kept = want.ranges.filter((range) => range.at === 'retain').map((range) => (range as O).id);
  assert.ok(kept.includes('tail'));
  assert.ok(!kept.includes('q:0'), 'the page next to the tail is let go first');
  assert.ok(kept.includes('q:5'), 'the page the reader is at is kept');
});

test('a positioned client resumes with positionedWindow, takes window frames at the position they stand at, and sends the moves', async () => {
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    positionedTranscripts: true,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent(); // initialized
  const client = await connecting;
  const settle = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  let seq = 0;
  const feed = (method: string, params: unknown, stamp = ++seq) =>
    conn.serverSend({ method, params, feed: { id: 't', epoch: 'e1', seq: stamp } });

  const resumed = client.resumeThread('t', { lastItems: 32 });
  const resume = JSON.parse(await conn.nextSent());
  assert.equal(resume.params.positionedWindow, true);
  conn.serverSend({
    id: resume.id,
    result: { thread: { id: 't' }, subscription: { id: 'sub-1', mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
  });
  await resumed;
  assert.equal(client.threadSubscription('t').subscriptionId, 'sub-1');
  feed('thread/snapshot', {
    thread: { id: 't' },
    state: {},
    items: [],
    hasOlder: true,
    window: {
      windowVersion: 1,
      lineage: 0,
      ranges: [{ id: 'tail', older: cont(pos('r8')), newer: end }],
      added: [{ range: 'tail', units: units(['r8', 'r9']) }],
      followTail: true,
    },
  });
  // A unit at the position the feed reached: no gap, no seq of its own.
  feed('thread/transcript/changed', { threadId: 't', lineage: 0, change: { op: 'insert', unit: unit(user('r10')) } }, seq);
  feed('thread/runtime/updated', { threadId: 't', value: { busy: true } });
  await settle();
  assert.deepEqual(ids((sessionStateOf(client, 't') as O).items), ['r8', 'r9', 'r10']);

  const moved = moveTranscriptWindow(client, 't', { kind: 'older' });
  const set = JSON.parse(await conn.nextSent());
  assert.equal(set.method, 'thread/window/set');
  assert.deepEqual(
    [set.params.subscriptionId, set.params.baseWindowVersion, set.params.want.ranges[1]],
    ['sub-1', 1, { at: 'before', position: pos('r8'), rows: 96 }]
  );
  conn.serverSend({ id: set.id, result: { requestId: set.params.requestId } });
  feed(
    'thread/window/changed',
    {
      threadId: 't',
      subscriptionId: 'sub-1',
      requestId: set.params.requestId,
      windowVersion: 2,
      lineage: 0,
      atFeedPosition: { epoch: 'e1', seq },
      ranges: [
        { id: 'tail', older: cont(pos('r8')), newer: end },
        { id: 'q', older: end, newer: cont(pos('r8')) },
      ],
      removed: [],
      added: [{ range: 'q', units: units(['r6', 'r7', 'r8']) }],
      followTail: true,
    },
    seq
  );
  assert.equal(await moved, true);
  const shown = sessionStateOf(client, 't') as O;
  assert.deepEqual(ids(shown.items), ['r6', 'r7', 'r8', 'r9', 'r10']);
  assert.equal(shown.transcriptHistory, 'held');
  await client.close();
});
