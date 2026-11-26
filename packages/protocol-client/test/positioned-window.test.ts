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
import { at, cont, end, pos } from './positioned-fixtures.ts';

type O = Record<string, any>;
const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

const user = (id: string, text = id) => ({
  type: 'userMessage',
  id,
  content: [{ type: 'text', text }],
  meta: { ext: { historyPosition: pos(id) } },
});
const reply = (id: string, text = id) => ({
  type: 'agentMessage',
  id,
  text,
  meta: { ext: { historyPosition: pos(id) } },
});
const unit = (item: O) => ({ position: pos(item.id), items: [item] });
const units = (ids: string[]) => ids.map((id, at) => unit(at % 2 ? reply(id) : user(id)));
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
  s = at(s, 'item/started', {
    turnId: 'x',
    item: { type: 'agentMessage', id: 'r3', text: '', meta: { status: 'inProgress' } },
  });
  s = at(s, 'item/agentMessage/delta', { itemId: 'r3', delta: 'stream' });
  // The record's own `item/completed` reaches a positioned subscription as a change with no row.
  s = at(s, 'thread/transcript/changed', { lineage: 1 });
  // The reply stays shown as it streamed until its record arrives: the turn's last output is told before its end.
  assert.deepEqual(ids(s.items), ['r1', 'r2']);
  assert.equal(state(s).streamingPartial?.text ?? state(s).streamingTail?.text, 'stream');
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
  assert.equal(s.live, null, 'the record takes the place of the reply streamed');
  // The turn's end, told after its last output, leaves no row of the client's making.
  s = at(s, 'turn/completed', { turnId: 'x' });
  assert.deepEqual(ids(s.items), ['r1', 'r2', 'r3']);
  assert.deepEqual(s.loose ?? [], []);
  // Another lineage's change, and a replace of a record not held, change nothing.
  assert.equal(
    at(s, 'thread/transcript/changed', { lineage: 2, change: { op: 'replace', unit: unit(reply('r3', 'x')) } }),
    s
  );
  assert.equal(
    at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: unit(reply('r9')) } }),
    s
  );
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

test('a followed tail past its bound is read anew: alone for a reader at the end, with the rows around a reader off it', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `g${String(i).padStart(4, '0')}`);
  const long = snapshot(ids(WINDOW_TAIL_MAX_ROWS + 300));
  const anew = { ranges: [], followTail: true, pinned: [] };
  assert.deepEqual(
    windowWant(long.held!, { kind: 'follow' }),
    anew,
    'no tail range is retained: the core reads the newest records'
  );
  assert.deepEqual(windowWant(long.held!, { kind: 'read', first: 'g2300', last: 'g2347', end: true }), anew);
  // A reader in the tail's stretch off its end keeps the rows in view and a page on each side.
  assert.deepEqual(windowWant(long.held!, { kind: 'read', first: 'g1000', last: 'g1010' }), {
    ranges: [{ at: 'around', position: pos('g1000'), before: 96, after: 11 + 96 }],
    followTail: true,
    pinned: [],
  });
  // A record opened elsewhere brings the tail anew beside it.
  assert.deepEqual(windowWant(long.held!, { kind: 'at', position: pos('a3') })?.ranges, [
    { at: 'around', position: pos('a3'), before: 96, after: 96 },
  ]);
});

test('following keeps a tail within its bound and the pages joined to it, and asks for nothing', () => {
  const grownIds = Array.from({ length: WINDOW_TAIL_MAX_ROWS - 100 }, (_, i) => `g${String(i).padStart(4, '0')}`);
  let s = snapshot(grownIds);
  assert.equal(windowWant(s.held!, { kind: 'follow' }), null, 'a tail within its bound is not read anew');
  // A page read above it is one stretch with it: sending a prompt from there (a follow) lets none of it go.
  s = at(s, 'thread/window/changed', {
    windowVersion: 11,
    lineage: 1,
    ranges: [
      { id: 'tail', older: cont(pos(grownIds[0]!)), newer: end },
      { id: 'q:above', older: cont(pos('f0')), newer: cont(pos(grownIds[0]!)) },
    ],
    removed: [],
    added: [{ range: 'q:above', units: units(['f0', 'f1', grownIds[0]!]) }],
    followTail: true,
  });
  assert.equal(windowWant(s.held!, { kind: 'follow' }), null);
  // A hit opened elsewhere keeps the tail as it is: no tail is read beside the range asked for.
  assert.deepEqual(windowWant(s.held!, { kind: 'at', position: pos('a3') })?.ranges, [
    { at: 'retain', id: 'tail' },
    { at: 'around', position: pos('a3'), before: 96, after: 96 },
  ]);
  // The stretch opened there is what a reader back on the tail lets go: the tail's run stays, and that is all it asks.
  s = at(s, 'thread/window/changed', {
    windowVersion: 12,
    lineage: 1,
    ranges: [
      { id: 'tail', older: cont(pos(grownIds[0]!)), newer: end },
      { id: 'q:above', older: cont(pos('f0')), newer: cont(pos(grownIds[0]!)) },
      { id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a5')) },
    ],
    removed: [],
    added: [{ range: 'q:hit', units: units(['a1', 'a2', 'a3', 'a4', 'a5']) }],
    followTail: true,
  });
  const back = windowWant(s.held!, { kind: 'follow' });
  assert.deepEqual(
    back?.ranges.map((range) => (range as O).id).sort(),
    ['q:above', 'tail'],
    'only the stretch apart from the tail is let go'
  );
  assert.equal(back?.followTail, true);
});

test('the moves a reader asks for: a page above, a bounded stretch, a hit opened', () => {
  const s = snapshot(['r20', 'r21']);
  // Fewer rows than the lead lie above the reader's view: the page above is asked for. A row no record holds stands at
  // the newest end.
  assert.deepEqual(windowWant(s.held!, { kind: 'read', first: 'r20', last: 'not-stored-yet' }), {
    ranges: [
      { at: 'retain', id: 'tail' },
      { at: 'before', position: pos('r20'), rows: 96 },
    ],
    followTail: true,
    pinned: [],
  });
  assert.equal(windowWant(s.held!, { kind: 'follow' }), null, 'the followed tail alone is what following holds');
  assert.equal(
    windowWant(snapshot(['r1', 'r2'], [], false).held!, { kind: 'read', first: 'r1', last: 'r2' }),
    null,
    'the transcript starts there'
  );
  assert.equal(windowWant(s.held!, { kind: 'at', position: pos('r21') }), null);
  assert.deepEqual(windowWant(s.held!, { kind: 'at', position: pos('r3') })?.ranges, [
    { at: 'retain', id: 'tail' },
    { at: 'around', position: pos('r3'), before: 96, after: 96 },
  ]);
  // Pages above the tail. The way back down shows the rows held: nothing is asked for, and nothing let go, while the
  // reader's view has the lead on both sides or the stretch is within its bound.
  let paged = snapshot(['p9999']);
  let next = 10000;
  const oldest: string[] = [];
  const grow = (page: number) => {
    const first = paged.held!.ranges.flatMap((range) => range.positions).sort()[0]!;
    const id = `q:${page}`;
    const rows = Array.from({ length: 96 }, () => `p${--next - 1}`).reverse();
    oldest.push(rows[0]!);
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
  };
  const keptAt = (row: string): string[] | null => {
    const want = windowWant(paged.held!, { kind: 'read', first: row, last: row });
    return want?.ranges.filter((range) => range.at === 'retain').map((range) => (range as O).id) ?? null;
  };
  for (let page = 0; page < 6; page++) grow(page);
  assert.equal(keptAt(oldest[2]!), null, 'in the middle of the rows held, nothing is asked for');
  assert.deepEqual(
    keptAt(oldest[5]!),
    ['tail', 'q:0', 'q:1', 'q:2', 'q:3', 'q:4', 'q:5'],
    'at the top, everything read stays'
  );
  // Past the bound, the pages farthest from the reader's view are let go; those within its lead and a page stay.
  for (let page = 6; page < 24; page++) grow(page);
  const kept = keptAt(oldest[23]!)!;
  assert.ok(kept.includes('tail'));
  assert.ok(!kept.includes('q:0'), 'the page next to the tail is let go first');
  assert.ok(
    ['q:21', 'q:22', 'q:23'].every((id) => kept.includes(id)),
    'the pages around the reader are kept'
  );
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
  feed(
    'thread/transcript/changed',
    { threadId: 't', lineage: 0, change: { op: 'insert', unit: unit(user('r10')) } },
    seq
  );
  feed('thread/runtime/updated', { threadId: 't', value: { busy: true } });
  await settle();
  assert.deepEqual(ids((sessionStateOf(client, 't') as O).items), ['r8', 'r9', 'r10']);

  const moved = moveTranscriptWindow(client, 't', { kind: 'read', first: 'r8', last: 'r10' });
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

test('a held record sent again with a compaction divider shows the divider after it, before the rows of the running turn', () => {
  let s = snapshot(['r1', 'r2']);
  s = at(s, 'item/started', {
    turnId: 'x',
    item: { type: 'agentMessage', id: 'live', text: '', meta: { status: 'inProgress' } },
  });
  s = at(s, 'item/agentMessage/delta', { itemId: 'live', delta: 'working' });
  // The divider's own event reaches a positioned subscription with no row.
  s = at(s, 'thread/transcript/changed', { lineage: 1 });
  const divided = {
    ...reply('r2'),
    meta: {
      ext: { historyPosition: pos('r2'), dividersAfter: [{ type: 'contextCompaction', id: 'divider:c1', meta: {} }] },
    },
  };
  s = at(s, 'thread/transcript/changed', {
    lineage: 1,
    change: { op: 'replace', unit: { position: pos('r2'), items: [divided] } },
  });
  assert.deepEqual(ids(s.items), ['r1', 'r2', 'divider:c1']);
  assert.equal(s.live?.id, 'live', 'the reply still streams under it');
  // A snapshot taken then carries the divider twice: on the record it follows and as the core's live row. It is shown once.
  const again = sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: [{ type: 'contextCompaction', id: 'divider:c1', meta: {} }],
    hasOlder: false,
    window: {
      windowVersion: 11,
      lineage: 1,
      ranges: [{ id: 'tail', older: end, newer: end }],
      added: [{ range: 'tail', units: [unit(user('r1')), { position: pos('r2'), items: [divided] }] }],
      followTail: true,
    },
  } as unknown as Json);
  assert.deepEqual(ids(again.items), ['r1', 'r2', 'divider:c1']);
});

test('a live reply completed blank ends its live row and folds to no row, in a positioned fold and a plain one', () => {
  const plain = sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: [],
    hasOlder: false,
  } as unknown as Json);
  for (const [name, start] of [
    ['positioned', snapshot(['r1', 'r2'])],
    ['plain', plain],
  ] as const) {
    const blank = (text: string) => ({ type: 'agentMessage', id: 'blank', text, meta: { status: 'inProgress' } });
    let s = at(start, 'item/started', { turnId: 'x', item: blank('') });
    s = at(s, 'item/agentMessage/delta', { itemId: 'blank', delta: '\n' });
    assert.equal(s.live?.id, 'blank', name);
    const rows = ids(s.items);
    s = at(s, 'item/completed', { turnId: 'x', item: blank('\n') });
    assert.equal(s.live, null, `${name}: the live row ends`);
    assert.equal(state(s).streamingTail ?? null, null, name);
    assert.deepEqual(ids(s.items), rows, `${name}: whitespace is no row`);
  }
});

test('small initial positioned snapshots fold synchronously in initialState without multi-tick pacing yields', async () => {
  const net = new MockNetwork();
  let now = 0;
  let yields = 0;
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    positionedTranscripts: true,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
    turn: {
      budgetMs: 0,
      now: () => {
        now += 10;
        return now;
      },
      yieldTurn: async () => {
        yields += 1;
        await new Promise((r) => setImmediate(r));
      },
    },
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const resumed = client.resumeThread('t-sync', { lastItems: 50 });
  const resume = JSON.parse(await conn.nextSent());
  conn.serverSend({
    id: resume.id,
    result: { thread: { id: 't-sync' }, subscription: { id: 'sub-sync', mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
  });
  await resumed;
  await new Promise((r) => setImmediate(r));
  yields = 0;
  const tailIds = Array.from({ length: 40 }, (_, i) => `m${i}`);
  conn.serverSend({
    method: 'thread/snapshot',
    params: {
      thread: { id: 't-sync' },
      state: {},
      items: [],
      hasOlder: true,
      window: {
        windowVersion: 1,
        lineage: 0,
        ranges: [{ id: 'tail', older: cont(pos(tailIds[0]!)), newer: end }],
        added: [{ range: 'tail', units: units(tailIds) }],
        followTail: true,
      },
    },
    feed: { id: 't-sync', epoch: 'e1', seq: 1 },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(ids((sessionStateOf(client, 't-sync') as O).items).length, 40);
  assert.equal(yields, 0, 'small positioned snapshot folds without pacing yields');
  await client.close();
});

test('carryShown purges superseded and removed unit IDs from shown.ids without fallback scans', async () => {
  const { countFoldWork, shownAt, transcriptChanged } = await import('../src/positioned.ts');
  const s = snapshot(['r1', 'r2', 'r3']);
  let held = s.held!;
  // Prime shown index on the window.
  assert.equal(shownAt(held, 'r2'), pos('r2'));
  const work = { placed: 0, copied: 0, merged: 0 };
  countFoldWork(work);
  try {
    // Replace unit at pos('r2') with a different item id.
    const replaced = transcriptChanged(
      held,
      { op: 'replace', unit: { position: pos('r2'), items: [reply('r2-new', 'updated')] } },
      (row) => row
    );
    assert.ok(replaced);
    held = replaced.window;
    work.copied = 0;
    assert.equal(shownAt(held, 'r2'), undefined, 'superseded id is purged from shown.ids');
    assert.equal(work.copied, 0, 'lookup of purged id does not scan all units');
    assert.equal(shownAt(held, 'r2-new'), pos('r2'));

    // Remove unit at pos('r3').
    const removed = transcriptChanged(held, { op: 'remove', position: pos('r3') }, (row) => row);
    assert.ok(removed);
    held = removed.window;
    work.copied = 0;
    assert.equal(shownAt(held, 'r3'), undefined, 'removed unit id is purged from shown.ids');
    assert.equal(work.copied, 0, 'lookup of removed id does not scan all units');
  } finally {
    countFoldWork(null);
  }
});
