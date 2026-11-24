// A positioned fold joins live and stored rows by identity alone and places a record by the ordinal it states: the rows no
// record shows yet stand at the transcript's newest end, in whichever stretch reaches it; a hole in the followed tail is
// stated and read; one reader's move keeps the stretch another stands in. Inputs are inline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json, ProtocolClient } from '../src/api.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';
import { at, cont, end, pos } from './positioned-fixtures.ts';
import {
  keepTranscriptWindow,
  moveTranscriptWindow,
  releaseTranscriptWindow,
  windowWant,
  WINDOW_PAGE_ROWS,
  WINDOW_TAIL_MAX_ROWS,
  WINDOW_VIEW_MAX_ROWS,
} from '../src/transcript-window.ts';

type O = Record<string, any>;

const reply = (id: string, text = id) => ({
  type: 'agentMessage',
  id,
  text,
  meta: { ext: { historyPosition: pos(id) } },
});
const call = (id: string, more: O = {}) => ({
  type: 'toolCall',
  id,
  name: 'read',
  input: { path: id },
  meta: { ...more },
});
const turnEnd = (of: string) => ({
  type: 'turnEnd',
  id: `${of}:2`,
  status: 'done',
  elapsedMs: 1,
  finalAssistantId: of,
  meta: {},
});
const unit = (id: string, ordinal?: number, ...more: O[]) => ({
  position: pos(id),
  items: [reply(id), ...more],
  ...(ordinal === undefined ? {} : { ordinal }),
});
const ids = (rows: readonly O[]) => rows.map((row) => row.id);
const state = (s: SessionFold) => desktopSessionState(s, []) as O;
const insert = (s: SessionFold, u: O, after?: string) =>
  at(s, 'thread/transcript/changed', {
    lineage: 1,
    change: { op: 'insert', ...(after ? { after: pos(after) } : {}), unit: u },
  });
const changed = (version: number, ranges: O[], added: O[]) => ({
  subscriptionId: 'sub',
  requestId: `q${version}`,
  windowVersion: version,
  lineage: 1,
  atFeedPosition: { epoch: 'e', seq: version },
  ranges,
  removed: [],
  added,
  followTail: true,
});
const snapshot = (tail: O[], loose: O[] = [], older = true) =>
  sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: loose,
    hasOlder: older,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: tail.length ? [{ id: 'tail', older: older ? cont(tail[0]!.position) : end, newer: end }] : [],
      added: tail.length ? [{ range: 'tail', units: tail }] : [],
      followTail: true,
    },
  } as unknown as Json);

test('a record that joins the tail stands where its ordinal says, whatever order the frames arrive in', () => {
  let s = snapshot([unit('r1', 10), unit('r2', 20)]);
  s = insert(s, unit('r4', 40), 'r2');
  s = insert(s, unit('r3', 30), 'r2');
  assert.deepEqual(ids(s.items), ['r1', 'r2', 'r3', 'r4']);
  assert.equal(s.held!.gap, undefined, 'each stands after a record held');
  // The same record told again as an insert is the record held: one row.
  s = insert(s, unit('r4', 40), 'r3');
  assert.deepEqual(ids(s.items), ['r1', 'r2', 'r3', 'r4']);
});

test('a page joined to the tail is ordered by the ordinals its records state', () => {
  let s = snapshot([unit('r5', 50), unit('r6', 60)]);
  // The page lists its records newest first: their place is the ordinal's, not the list's.
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'tail', older: cont(pos('r5')), newer: end },
        { id: 'q:up', older: end, newer: cont(pos('r5')) },
      ],
      [{ range: 'q:up', units: [unit('r5', 50), unit('r4', 40), unit('r3', 30)] }]
    )
  );
  assert.deepEqual(ids(s.items), ['r3', 'r4', 'r5', 'r6']);
});

test('a row shown ahead of its record is the same row once the record is told: joined by identity, never placed twice', () => {
  let s = snapshot([unit('r1', 10)], [call('c1', { status: 'inProgress' })]);
  assert.deepEqual(ids(s.items), ['r1', 'c1'], 'a row in progress stands at the end');
  s = at(s, 'item/completed', { turnId: 'x', item: call('c1', { status: 'completed' }) });
  s = at(s, 'item/started', { turnId: 'x', item: call('c2', { status: 'inProgress' }) });
  assert.deepEqual(ids(s.items), ['r1', 'c1', 'c2']);
  // The record that shows c1 is stored: the row shown for it gives way, the one still in progress stays last.
  s = insert(s, { position: pos('c1'), ordinal: 20, items: [call('c1', { status: 'completed' })] }, 'r1');
  assert.deepEqual(ids(s.items), ['r1', 'c1', 'c2']);
  assert.deepEqual(ids(s.loose ?? []), ['c2']);
  // A row sent again for an item a record holds changes nothing.
  assert.equal(at(s, 'item/completed', { turnId: 'x', item: call('c1', { status: 'completed' }) }), s);
});

test('a stretch apart from the tail shows its settled rows, and the rows in progress only where it reaches the end', () => {
  // A window that holds no tail record (a tail read anew still to land), a call in progress, and the reader's stretch.
  let s = snapshot([], [call('live', { status: 'inProgress' })]);
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [{ id: 'q:at', older: cont(pos('a1')), newer: end }],
      [{ range: 'q:at', units: [unit('a1', 10), unit('a2', 20, turnEnd('a2'))] }]
    )
  );
  let shown = state(s);
  assert.deepEqual(
    ids(shown.transcriptViewItems),
    ['a1', 'a2', 'a2:2', 'live'],
    'a settled end and the row in progress'
  );
  assert.deepEqual(
    shown.transcriptViews.map((view: O) => [ids(view.items), view.before, view.after]),
    [[['a1', 'a2', 'a2:2', 'live'], true, false]]
  );
  // The tail read anew arrives apart from it: the stretch goes on toward newer rows, and the row in progress is the tail's.
  s = at(
    s,
    'thread/window/changed',
    changed(
      12,
      [
        { id: 'q:at', older: cont(pos('a1')), newer: cont(pos('a2')) },
        { id: 'tail', older: cont(pos('r8')), newer: end },
      ],
      [{ range: 'tail', units: [unit('r8', 80), unit('r9', 90)] }]
    )
  );
  shown = state(s);
  assert.deepEqual(ids(shown.transcriptViewItems), ['a1', 'a2', 'a2:2']);
  assert.deepEqual(ids(s.items), ['r8', 'r9', 'live']);
  // A row in progress that changes leaves the stretch's rows the array they were.
  const next = at(s, 'item/completed', { turnId: 'x', item: call('live', { status: 'completed' }) });
  assert.equal(state(next).transcriptViewItems, shown.transcriptViewItems);
});

test('a record that joins the tail past one the tail does not hold states the hole, and a tail read anew closes it', () => {
  let s = snapshot([unit('r1', 10), unit('r2', 20)]);
  s = insert(s, unit('r5', 50), 'r4');
  assert.equal(s.held!.gap, pos('r2'), 'the records between r2 and r5 are still to be read');
  assert.deepEqual(ids(s.items), ['r1', 'r2', 'r5'], 'nothing is put in their place');
  s = insert(s, unit('r6', 60), 'r5');
  assert.equal(s.held!.gap, pos('r2'), 'the hole stays stated');
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [{ id: 'tail', older: cont(pos('r3')), newer: end }],
      [{ range: 'tail', units: [unit('r3', 30), unit('r4', 40), unit('r5', 50), unit('r6', 60)] }]
    )
  );
  assert.equal(s.held!.gap, undefined);
  assert.deepEqual(ids(s.items), ['r3', 'r4', 'r5', 'r6']);
});

/** A client that holds one fold and records the windows asked of it. */
function fakeClient(fold: SessionFold) {
  const wants: O[] = [];
  const listeners = new Set<(change: O) => void>();
  const client = {
    fold,
    wants,
    store: {
      thread: () => ({ state: client.fold }),
      subscribe: (listener: (change: O) => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    on: () => () => undefined,
    threadSubscription: () => ({ subscriptionId: 'sub' }),
    fail: false,
    call: async (_method: string, params: O) => {
      wants.push(params.want);
      if (client.fail) throw new Error('the read failed');
      return { requestId: params.requestId };
    },
    land(next: SessionFold) {
      client.fold = next;
      for (const listener of [...listeners]) listener({ type: 'thread', threadId: 't' });
    },
  };
  return client;
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('what the window owes is asked for by one definition: a hole is read with what every reader stands near kept', async () => {
  let s = snapshot([unit('r1', 10), unit('r2', 20)]);
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'tail', older: cont(pos('r1')), newer: end },
        { id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a2')) },
      ],
      [{ range: 'q:hit', units: [unit('a1', 1), unit('a2', 2)] }]
    )
  );
  const whole = fakeClient(s);
  assert.equal(await keepTranscriptWindow(whole as unknown as ProtocolClient<SessionFold>, 't'), true);
  assert.deepEqual(whole.wants, [], 'a window that owes nothing is asked nothing');
  const holed = fakeClient(insert(s, unit('r5', 50), 'r4'));
  const client = holed as unknown as ProtocolClient<SessionFold>;
  // One reader in the stretch apart, one in the tail's stretch above its end: the hole is read as a move would read
  // a tail anew, each keeping what it stands near.
  const readers = [
    { kind: 'read', first: 'a1', last: 'a2', reader: 'left' },
    { kind: 'read', first: 'r1', last: 'r1', reader: 'right' },
  ] as const;
  const mended = {
    ranges: [
      { at: 'retain', id: 'q:hit' },
      { at: 'around', position: pos('r1'), before: 96, after: 1 + 96 },
    ],
    followTail: true,
    pinned: [],
  };
  assert.deepEqual(windowWant(holed.fold.held!, { kind: 'keep' }, readers), mended);
  assert.deepEqual(
    windowWant(holed.fold.held!, { kind: 'follow', reader: 'third' }, readers),
    mended,
    'as a move asks it'
  );
  // Asked once, however many changes land while the read is out.
  void keepTranscriptWindow(client, 't');
  const again = keepTranscriptWindow(client, 't');
  await settled();
  assert.equal(await again, true);
  assert.equal(holed.wants.length, 1, 'one read');
});

test('a tail past its bound is read anew with no reader moving, and with no reader at all', async () => {
  const many = Array.from({ length: WINDOW_TAIL_MAX_ROWS + 1 }, (_, i) =>
    unit(`g${String(i).padStart(4, '0')}`, 1_000 + i)
  );
  const client = fakeClient(snapshot(many.slice(0, -1)));
  const sent = client as unknown as ProtocolClient<SessionFold>;
  // Each record that arrives is a change of the thread: the lane asks what the window owes.
  assert.equal(await keepTranscriptWindow(sent, 't'), true);
  assert.deepEqual(client.wants, [], 'within its bound');
  client.fold = insert(client.fold, many.at(-1)!);
  void keepTranscriptWindow(sent, 't');
  await settled();
  assert.deepEqual(client.wants, [{ ranges: [], followTail: true, pinned: [] }]);
});

test('a window the core let go is asked for again by the next thing that needs it', async () => {
  let s = snapshot([unit('r1', 10), unit('r2', 20)]);
  // A read of the core's own failed: the subscription is left holding nothing, and following nothing.
  s = at(s, 'thread/window/changed', { ...changed(11, [], []), followTail: false });
  assert.deepEqual(ids(s.items), []);
  const anew = { ranges: [], followTail: true, pinned: [] };
  assert.deepEqual(
    windowWant(s.held!, { kind: 'read', first: 'r1', last: 'r2', end: true }),
    anew,
    "a follower's next move"
  );
  assert.deepEqual(windowWant(s.held!, { kind: 'follow' }), anew);
  const client = fakeClient(s);
  void keepTranscriptWindow(client as unknown as ProtocolClient<SessionFold>, 't');
  await settled();
  assert.deepEqual(client.wants, [anew], 'and the next change of the thread');
  // That read failing leaves an idle thread with nothing to grow: no change asks again, and a reader that needs
  // the rows does.
  const failing = fakeClient(s);
  const sent = failing as unknown as ProtocolClient<SessionFold>;
  failing.fail = true;
  assert.equal(await keepTranscriptWindow(sent, 't'), false);
  assert.equal(await keepTranscriptWindow(sent, 't'), false);
  assert.equal(failing.wants.length, 1, 'not for every change');
  failing.fail = false;
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'r1', last: 'r2', end: true, reader: 'A' });
  await settled();
  assert.deepEqual(failing.wants, [anew, anew], 'a pane showing the session asks');
});

test('what the window kept of a thread that ended is released: the thread opened again is asked afresh', async () => {
  const s = insert(snapshot([unit('r1', 10), unit('r2', 20)]), unit('r5', 50), 'r4');
  const client = fakeClient(s);
  const sent = client as unknown as ProtocolClient<SessionFold>;
  client.fail = true;
  assert.equal(await keepTranscriptWindow(sent, 't'), false);
  assert.equal(await keepTranscriptWindow(sent, 't'), false);
  assert.equal(client.wants.length, 1, 'a failed read is not asked again on the same window');
  releaseTranscriptWindow(sent, 't');
  assert.equal(await keepTranscriptWindow(sent, 't'), false);
  assert.equal(client.wants.length, 2, 'the failure belonged to the thread that ended');
});

test('a read of what the window owes that fails is asked again by one rule: another window, or a page more held', async () => {
  const s = insert(snapshot([unit('r1', 10), unit('r2', 20)]), unit('r5', 50), 'r4');
  const client = fakeClient(s);
  const sent = client as unknown as ProtocolClient<SessionFold>;
  client.fail = true;
  assert.equal(await keepTranscriptWindow(sent, 't'), false);
  // The reads of the tail anew (they retain no tail range); a page a reader asks for is another matter.
  const anew = () =>
    client.wants.filter((want) => !want.ranges.some((range: O) => range.at === 'retain' && range.id === 'tail'));
  assert.equal(anew().length, 1);
  // Records keep arriving on the same window: none of them asks again.
  for (let n = 0; n < 5; n += 1) {
    client.fold = insert(client.fold, unit(`n${n}`, 100 + n));
    assert.equal(await keepTranscriptWindow(sent, 't'), false);
  }
  assert.equal(anew().length, 1, 'no retry per record');
  // A reader's move follows the same rule: it asks nothing of what failed, before its own want or as it.
  await moveTranscriptWindow(sent, 't', { kind: 'read', first: 'n4', last: 'n4', end: true, reader: 'A' });
  await moveTranscriptWindow(sent, 't', { kind: 'follow', reader: 'A' });
  assert.equal(anew().length, 1, 'no retry per move');
  // What is held grew by a page: the read owed is asked again, once.
  for (let n = 5; n < 5 + WINDOW_PAGE_ROWS; n += 1) {
    client.fold = insert(client.fold, unit(`n${n}`, 100 + n));
    await keepTranscriptWindow(sent, 't');
  }
  assert.equal(anew().length, 2, 'asked again by the change that grew the tail a page');
  // Another window (a restore, a change the core made) can make it succeed: it is asked of that one.
  client.fail = false;
  client.fold = { ...client.fold, held: { ...client.fold.held!, version: client.fold.held!.version + 1 } };
  void keepTranscriptWindow(sent, 't');
  await settled();
  assert.equal(anew().length, 3);
});

test('a fresh tail larger than the bound is not read anew for every record: only once it holds twice what the core gave', async () => {
  // Thirty-two records of a hundred rows each: the core's fresh tail alone is past the bound.
  const big = (id: string, ordinal: number) => ({
    position: pos(id),
    ordinal,
    items: Array.from({ length: 100 }, (_, k) => reply(k === 0 ? id : `${id}.${k}`)),
  });
  const fresh = Array.from({ length: 32 }, (_, n) => big(`f${n}`, 1_000 + n));
  const client = fakeClient(snapshot(fresh));
  const sent = client as unknown as ProtocolClient<SessionFold>;
  // Past the bound as given: read anew once, and the core gives the same tail.
  void keepTranscriptWindow(sent, 't');
  await settled();
  assert.equal(client.wants.length, 1);
  client.land({ ...client.fold, held: { ...client.fold.held!, version: 11 } });
  await settled();
  for (let n = 0; n < 20; n += 1) {
    client.fold = insert(client.fold, big(`m${n}`, 2_000 + n));
    await keepTranscriptWindow(sent, 't');
  }
  assert.equal(client.wants.length, 1, 'no read for the records that arrive on it');
  for (let n = 20; n < 33; n += 1) client.fold = insert(client.fold, big(`m${n}`, 2_000 + n));
  void keepTranscriptWindow(sent, 't');
  await settled();
  assert.equal(client.wants.length, 2, 'read anew at twice the rows it was given');
});

test('an id two records show is still shown by the other when the one it was last told for is let go', () => {
  let s = snapshot([unit('r1', 10, reply('both')), unit('r2', 20, reply('both'))]);
  assert.equal(at(s, 'item/completed', { turnId: 'x', item: reply('both') }), s, 'a record shows it');
  s = at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'remove', position: pos('r2') } });
  assert.deepEqual(ids(s.items), ['r1', 'both']);
  // The item told again is the row r1 holds: nothing is added beside it.
  assert.equal(at(s, 'item/completed', { turnId: 'x', item: reply('both') }), s);
  // Let go of that one too, the id is no record's.
  s = at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'remove', position: pos('r1') } });
  assert.deepEqual(ids(at(s, 'item/completed', { turnId: 'x', item: reply('both') }).items), ['both']);
});

test('each reader holds what is near it: two in one stretch apart, one paging far, hold two bounded stretches', () => {
  // A stretch apart of sixty pages, each sharing a record with the next; a short tail.
  const PAGES = 60;
  const STEP = WINDOW_PAGE_ROWS - 1;
  const records = Array.from({ length: PAGES * STEP + 1 }, (_, i) => unit(`a${String(i).padStart(4, '0')}`, i));
  let s = snapshot([unit('r1', 90_000), unit('r2', 90_001)]);
  const ranges: O[] = [{ id: 'tail', older: cont(pos('r1')), newer: end }];
  const added: O[] = [];
  for (let page = 0; page < PAGES; page += 1) {
    const units = records.slice(page * STEP, page * STEP + WINDOW_PAGE_ROWS);
    ranges.push({
      id: `q:${page}`,
      older: page === 0 ? cont(pos('a0000')) : cont(units[0]!.position),
      newer: cont(units.at(-1)!.position),
    });
    added.push({ range: `q:${page}`, units });
  }
  s = at(s, 'thread/window/changed', changed(11, ranges, added));
  const held = s.held!;
  assert.equal(held.units.size, records.length + 2);
  const rowsKept = (want: O | null): number => {
    const kept = new Set<string>();
    for (const range of want?.ranges ?? [])
      if (range.at === 'retain')
        for (const position of held.ranges.find((r) => r.id === range.id)!.positions) kept.add(position);
    return kept.size;
  };
  // B opened the hit at the stretch's newest end and stays; A paged up to its oldest end and asks for the next page.
  const last = records.length - 1;
  const b = { kind: 'read', first: `a${last - 20}`, last: `a${last - 10}`, reader: 'B' } as const;
  const a = { kind: 'read', first: 'a0010', last: 'a0020', reader: 'A' } as const;
  const alone = windowWant(held, a);
  const both = windowWant(held, a, [b]);
  assert.equal(both?.ranges.at(-1)?.at, 'before');
  assert.ok(rowsKept(alone) <= 2 + WINDOW_VIEW_MAX_ROWS, `one reader: ${rowsKept(alone)} rows kept`);
  // The window's largest size: the tail, and for each reader its bound and the page it asks for.
  const most = WINDOW_TAIL_MAX_ROWS + 2 * (WINDOW_VIEW_MAX_ROWS + WINDOW_PAGE_ROWS);
  assert.ok(rowsKept(both) + WINDOW_PAGE_ROWS <= most, `two readers: ${rowsKept(both)} rows kept`);
  assert.ok(
    rowsKept(both) <= 2 + 2 * WINDOW_VIEW_MAX_ROWS,
    `two readers: ${rowsKept(both)} rows kept of ${records.length}`
  );
  assert.ok(rowsKept(both) < records.length - 1_000, 'the pages between them are let go');
  const retained = new Set((both?.ranges ?? []).map((range: O) => range.id));
  assert.ok(
    retained.has('q:0') && retained.has(`q:${PAGES - 1}`) && retained.has('tail'),
    'each keeps the rows it shows'
  );
  assert.ok(!retained.has(`q:${PAGES / 2}`), 'nobody is near the middle');
  // B's own move, standing still elsewhere, keeps the same: neither reader's want lets go of the other's rows.
  const stands = windowWant(held, { kind: 'at', position: pos('zz'), reader: 'C' }, [a, b]);
  assert.ok(new Set(stands!.ranges.map((range: O) => range.id)).has('q:0'));
  assert.ok(rowsKept(stands) <= 2 + 2 * WINDOW_VIEW_MAX_ROWS);
});

test('a superseded record map, record and row is unreachable once the change that replaced it is applied', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const collect = vm.runInNewContext('gc') as () => void;
  const made = (): { fold: SessionFold; maps: WeakRef<object>[]; rows: WeakRef<object>[] } => {
    let s = snapshot(Array.from({ length: 300 }, (_, i) => unit(`g${i}`, 1_000 + i)));
    const maps: WeakRef<object>[] = [];
    const rows: WeakRef<object>[] = [];
    // A compaction: every record is told again, each read as a pane reads it.
    for (let i = 0; i < 300; i += 1) {
      maps.push(new WeakRef(s.held!.units));
      rows.push(new WeakRef(s.held!.units.get(pos(`g${i}`))!.rows[0]!));
      s = at(s, 'thread/transcript/changed', {
        lineage: 1,
        change: { op: 'replace', unit: { ...unit(`g${i}`, 1_000 + i), items: [reply(`g${i}`, 'again')] } },
      });
      state(s);
    }
    return { fold: s, maps, rows };
  };
  const { fold, maps, rows } = made();
  await settled();
  collect();
  const live = (refs: WeakRef<object>[]) => refs.filter((ref) => ref.deref() !== undefined).length;
  // Beyond the current window the store keeps the map the last whole copy was made from, until the next one (every
  // 64 changes), with the records told since: none of the maps before it, and none of their rows.
  assert.ok(live(maps) <= 2, `${live(maps)} superseded maps still reachable`);
  assert.ok(live(rows) <= 64, `${live(rows)} superseded rows still reachable`);
  assert.equal(fold.held!.units.size, 300);
});

test('the rows made for a stretch apart live as long as the stretch is shown: joined to the tail, or left by its reader, they are let go', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const collect = vm.runInNewContext('gc') as () => void;
  const apart = (ranges: O[], added: O[], version: number) =>
    changed(version, [{ id: 'tail', older: cont(pos('r8')), newer: end }, ...ranges], added);
  for (const ending of ['joins the tail', 'is left by its reader'] as const) {
    const made = (): { fold: SessionFold; refs: WeakRef<object>[] } => {
      let s = snapshot([unit('r8', 80), unit('r9', 90)]);
      // A change of the tail first: the fold carries its stretches from here on.
      s = insert(s, unit('r10', 100), 'r9');
      s = at(
        s,
        'thread/window/changed',
        apart(
          [{ id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a3')) }],
          [{ range: 'q:hit', units: [unit('a1', 1), unit('a2', 2), unit('a3', 3)] }],
          11
        )
      );
      const shown = state(s);
      assert.deepEqual(ids(shown.transcriptViewItems), ['a1', 'a2', 'a3']);
      // What the stretch's cache holds: the record map it was made from, and the rows merged for it.
      const refs = [new WeakRef(s.held!.units as object), new WeakRef(shown.transcriptViewItems as object)];
      // A stretch its reader left takes its records with it. (One that joined the tail keeps them, and a record
      // replaced there stays in the map the last whole copy was made from until the next: the store's stated hold.)
      if (ending === 'is left by its reader') refs.push(new WeakRef(s.held!.units.get(pos('a2'))!.rows[0]!));
      if (ending === 'joins the tail') {
        // The reader pages down until the stretch shares a record with the tail: it is the tail's stretch now, and
        // its first record stays held.
        s = at(
          s,
          'thread/window/changed',
          apart(
            [
              { id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a3')) },
              { id: 'q:down', older: cont(pos('a3')), newer: cont(pos('r8')) },
            ],
            [{ range: 'q:down', units: [unit('a3', 3), unit('r8', 80)] }],
            12
          )
        );
        assert.equal(state(s).transcriptViewItems, null);
        assert.deepEqual(ids(s.items).slice(0, 3), ['a1', 'a2', 'a3']);
      } else {
        s = at(s, 'thread/window/changed', apart([], [], 12));
        assert.equal(state(s).transcriptViewItems, null);
      }
      s = at(s, 'thread/transcript/changed', {
        lineage: 1,
        change: { op: 'replace', unit: { ...unit('r9', 90), items: [reply('r9', 'again')] } },
      });
      if (ending === 'joins the tail')
        s = at(s, 'thread/transcript/changed', {
          lineage: 1,
          change: { op: 'replace', unit: { ...unit('a2', 2), items: [reply('a2', 'again')] } },
        });
      state(s);
      return { fold: s, refs };
    };
    const { fold, refs } = made();
    await settled();
    collect();
    assert.deepEqual(
      refs.map((ref) => ref.deref() !== undefined),
      refs.map(() => false),
      `${ending}: the map and the merged rows of the stretch are unreachable`
    );
    assert.ok(fold.held);
  }
});

test('a record that lands before everything the tail holds states a hole too', () => {
  const s = insert(snapshot([unit('r5', 50), unit('r6', 60)]), unit('r2', 20), 'r1');
  assert.deepEqual(ids(s.items), ['r2', 'r5', 'r6']);
  assert.equal(s.held!.gap, pos('r2'), 'what lies between it and the first record held is not known');
});

test("two readers of one window: one's move never lets go of the stretch the other stands in", async () => {
  const many = Array.from({ length: WINDOW_TAIL_MAX_ROWS + 300 }, (_, i) =>
    unit(`g${String(i).padStart(4, '0')}`, 1_000 + i)
  );
  let s = snapshot(many);
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'tail', older: cont(pos('g0000')), newer: end },
        { id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a3')) },
      ],
      [{ range: 'q:hit', units: [unit('a1', 1), unit('a2', 2), unit('a3', 3)] }]
    )
  );
  const held = s.held!;
  const inHit = { kind: 'read', first: 'a1', last: 'a3', reader: 'left' } as const;
  const inTail = { kind: 'read', first: 'g1000', last: 'g1010', reader: 'right' } as const;
  const retained = (want: O | null) =>
    want && want.ranges.filter((range: O) => range.at === 'retain').map((range: O) => range.id);
  // A reader off the end of a tail past its bound keeps its own rows and the other's stretch.
  const offEnd = windowWant(held, inTail, [inHit]);
  assert.deepEqual(retained(offEnd), ['q:hit']);
  assert.equal(offEnd?.ranges.at(-1)?.at, 'around');
  // Alone, the stretch apart is nobody's: it goes with the tail read anew.
  assert.deepEqual(retained(windowWant(held, inTail)), []);
  // The mirror: a reader following the end reads the tail anew, and the one who stands in its stretch off the end,
  // however long it stands there, keeps the rows around its view and nothing more.
  const theirs = { at: 'around', position: pos('g1000'), before: 96, after: 11 + 96 };
  for (const follower of [
    { kind: 'follow', reader: 'left' },
    { kind: 'read', first: 'g2340', last: 'g2347', end: true, reader: 'left' },
  ] as const)
    assert.deepEqual(windowWant(held, follower, [inTail]), { ranges: [theirs], followTail: true, pinned: [] });
  // A record opened by one keeps the other's stretch, and the rows the other reads.
  assert.deepEqual(retained(windowWant(held, { kind: 'at', position: pos('z9'), reader: 'right' }, [inHit])), [
    'q:hit',
  ]);
  assert.deepEqual(windowWant(held, { kind: 'at', position: pos('z9'), reader: 'left' }, [inTail])?.ranges, [
    { at: 'around', position: pos('z9'), before: 96, after: 96 },
    theirs,
  ]);
  // Both stretches are stated, each for the reader it shows.
  const more = at(
    s,
    'thread/window/changed',
    changed(
      12,
      [
        { id: 'tail', older: cont(pos('g0000')), newer: end },
        { id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a3')) },
        { id: 'q:z', older: cont(pos('z8')), newer: cont(pos('z9')) },
      ],
      [{ range: 'q:z', units: [unit('z8', 8), unit('z9', 9)] }]
    )
  );
  assert.deepEqual(
    state(more).transcriptViews.map((view: O) => ids(view.items)),
    [
      ['a1', 'a2', 'a3'],
      ['z8', 'z9'],
    ]
  );
  // The moves sent say who stands where: the second reader's page keeps the first one's stretch.
  const client = fakeClient(more);
  const sent = client as unknown as ProtocolClient<SessionFold>;
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'a1', last: 'a3', reader: 'left' });
  await settled();
  for (const version of [13, 14]) {
    client.land({ ...more, held: { ...more.held!, version } });
    await settled();
  }
  // The tail, past its bound and with no reader off its end, is read anew beside the stretch a reader stands in.
  assert.deepEqual(retained(client.wants[0]!), ['q:hit']);
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'z8', last: 'z9', reader: 'right' });
  await settled();
  // The second reader's page keeps the first one's stretch, its own and the tail the core gave.
  assert.deepEqual(retained(client.wants.at(-1)!)?.sort(), ['q:hit', 'q:z', 'tail']);
});

test('a reader exists as long as its pane shows the thread: withdrawn, what only it held is released', async () => {
  const many = Array.from({ length: WINDOW_TAIL_MAX_ROWS - 200 }, (_, i) =>
    unit(`g${String(i).padStart(4, '0')}`, 1_000 + i)
  );
  let s = snapshot(many);
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'tail', older: cont(pos('g0000')), newer: end },
        { id: 'q:hit', older: end, newer: end },
      ],
      [{ range: 'q:hit', units: [unit('a1', 1), unit('a2', 2), unit('a3', 3)] }]
    )
  );
  const client = fakeClient(s);
  const sent = client as unknown as ProtocolClient<SessionFold>;
  const rows = () => [...client.fold.held!.units.values()].reduce((count, held) => count + held.rows.length, 0);
  const retained = (want: O) => want.ranges.filter((range: O) => range.at === 'retain').map((range: O) => range.id);
  // Pane A reads the stretch apart; pane B follows the end. Nothing is asked: the window serves both.
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'a2', last: 'a2', reader: 'A' });
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'g1840', last: 'g1847', end: true, reader: 'B' });
  await settled();
  assert.deepEqual(client.wants, []);
  // A closes, or shows another session: its withdrawal lets go of the stretch only it held.
  void moveTranscriptWindow(sent, 't', { kind: 'follow', reader: 'A' });
  await settled();
  assert.deepEqual(client.wants.map(retained), [['tail']]);
  client.land(
    at(client.fold, 'thread/window/changed', changed(12, [{ id: 'tail', older: cont(pos('g0000')), newer: end }], []))
  );
  await settled();
  assert.equal(rows(), many.length, 'the stretch is gone');
  // The same with A standing in the tail's stretch off its end before it left: B's long run is bounded.
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'g0400', last: 'g0410', reader: 'A' });
  void moveTranscriptWindow(sent, 't', { kind: 'follow', reader: 'A' });
  await settled();
  let grown = client.fold;
  for (let n = 0; n < 400; n += 1) grown = insert(grown, unit(`n${n}`, 9_000 + n));
  client.land(grown);
  const before = rows();
  assert.ok(before > WINDOW_TAIL_MAX_ROWS, 'the tail grew past its bound');
  void moveTranscriptWindow(sent, 't', { kind: 'read', first: 'n390', last: 'n399', end: true, reader: 'B' });
  await settled();
  assert.deepEqual(
    client.wants.at(-1),
    { ranges: [], followTail: true, pinned: [] },
    'the tail is read anew, nothing of A kept'
  );
});

test('a reader standing still off the end does not keep the tail from being bounded', () => {
  const many = Array.from({ length: WINDOW_TAIL_MAX_ROWS + 300 }, (_, i) =>
    unit(`g${String(i).padStart(4, '0')}`, 1_000 + i)
  );
  let s = snapshot(many);
  // B sits a screen up and does not move; A follows the run.
  const still = { kind: 'read', first: 'g2300', last: 'g2310', reader: 'B' } as const;
  const want = windowWant(s.held!, { kind: 'read', first: 'g2340', last: 'g2347', end: true, reader: 'A' }, [still]);
  assert.deepEqual(want, {
    ranges: [{ at: 'around', position: pos('g2300'), before: 96, after: 11 + 96 }],
    followTail: true,
    pinned: [],
  });
  // The window granted: the tail anew and B's rows, a stretch of its own or one with the tail where they meet.
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'q:b', older: cont(pos('g2204')), newer: cont(pos('g2347')) },
        { id: 'tail', older: cont(pos('g2300')), newer: end },
      ],
      [
        { range: 'q:b', units: many.slice(2204) },
        { range: 'tail', units: many.slice(2300) },
      ]
    )
  );
  assert.equal(s.held!.units.size, 2348 - 2204, 'what is held is what the two readers are near');
  // The run goes on for long with B still: every bound crossed is read anew, B's rows kept as its own stretch.
  for (let n = 0; n < WINDOW_TAIL_MAX_ROWS; n += 1)
    s = at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'insert', unit: unit(`n${n}`, 9_000 + n) } });
  const again = windowWant(s.held!, { kind: 'read', first: 'n2040', last: 'n2047', end: true, reader: 'A' }, [still]);
  assert.equal(again?.ranges.length, 1);
  assert.deepEqual(again?.ranges[0], { at: 'around', position: pos('g2300'), before: 96, after: 11 + 96 });
});

test('a waiting move gives way only to a later move of its own reader: a page asked by one pane is sent while another streams at the end', async () => {
  // A short tail that ends the transcript, and a stretch apart with older rows to read.
  let s = snapshot([unit('r1', 90), unit('r2', 91)], [], false);
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'tail', older: end, newer: end },
        { id: 'q:hit', older: cont(pos('a1')), newer: cont(pos('a3')) },
      ],
      [{ range: 'q:hit', units: [unit('a1', 1), unit('a2', 2), unit('a3', 3)] }]
    )
  );
  const client = fakeClient(s);
  const sent = client as unknown as ProtocolClient<SessionFold>;
  // A step is out: a third reader opens a record the window does not hold.
  const opened = moveTranscriptWindow(sent, 't', { kind: 'at', position: pos('z9'), reader: 'C' });
  await settled();
  assert.equal(client.wants.length, 1);
  // Pane A, at the top of its stretch, asks for the older page; pane B, at the end of a streaming turn, says where
  // it is each time its rows change, before and after.
  const endOfB = { kind: 'read', first: 'r1', last: 'r2', end: true, reader: 'B' } as const;
  const first = moveTranscriptWindow(sent, 't', endOfB);
  const page = moveTranscriptWindow(sent, 't', { kind: 'read', first: 'a1', last: 'a2', reader: 'A' });
  const second = moveTranscriptWindow(sent, 't', endOfB);
  const third = moveTranscriptWindow(sent, 't', endOfB);
  // The step out returns (the window moves on).
  client.land({ ...client.fold, held: { ...client.fold.held!, version: 12 } });
  await settled();
  // A's page is asked of the core: B's reads, which need nothing, did not take its place.
  assert.equal(client.wants.length, 2);
  assert.deepEqual(client.wants[1]!.ranges.at(-1), { at: 'before', position: pos('a1'), rows: WINDOW_PAGE_ROWS });
  client.land({ ...client.fold, held: { ...client.fold.held!, version: 13 } });
  await settled();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(await page, true);
  assert.equal(await opened, false, 'the record opened is not held: its own answer');
  assert.equal(client.wants.length, 2, "B's three reads were one move, and asked nothing");
});
