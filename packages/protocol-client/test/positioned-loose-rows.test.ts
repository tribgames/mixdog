// Where a positioned fold shows the rows no stored record holds (a turn's live end): among the records they stand
// after, never gathered at an edge of the window. Inputs are inline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;

const pos = (id: string) => `h1:0:${id}`;
const reply = (id: string) => ({ type: 'agentMessage', id, text: id, meta: { ext: { historyPosition: pos(id) } } });
const unit = (id: string) => ({ position: pos(id), items: [reply(id)] });
const turnEnd = (id: string, ext: O = {}) => ({ type: 'turnEnd', id, status: 'done', elapsedMs: 1, meta: { ext } });
const cont = (position: string) => ({ kind: 'continuation', position });
const end = { kind: 'end' };
const at = (s: SessionFold, method: string, params: O) =>
  sessionReducer.apply(s, { method, params: { threadId: 't', ...params } } as never);
const ids = (rows: readonly O[]) => rows.map((row) => row.id);
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

const snapshot = (tail: string[], loose: O[], older: boolean) =>
  sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: loose,
    hasOlder: older,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: older ? cont(pos(tail[0]!)) : end, newer: end }],
      added: [{ range: 'tail', units: tail.map(unit) }],
      followTail: true,
    },
  } as unknown as Json);

test('a row only the view holds is kept by a snapshot: before the first record, and back beside a record paged in', () => {
  // The thread's start is held: a row no record precedes stands before the first one.
  const start = snapshot(['r1', 'r2'], [turnEnd('lead', { shownBefore: pos('r1') })], false);
  assert.deepEqual(ids(start.items), ['lead', 'r1', 'r2']);

  // A stop line whose prompt lies just above the records carried: of the history above, held until its record is.
  let s = snapshot(['r3', 'r4'], [turnEnd('stop', { shownAfter: pos('r2'), shownStored: true })], true);
  assert.deepEqual(ids(s.items), ['r3', 'r4']);
  assert.deepEqual(ids(s.loose ?? []), ['stop'], 'the line is held, though no record shown carries it');
  s = at(
    s,
    'thread/window/changed',
    changed(
      11,
      [
        { id: 'tail', older: cont(pos('r3')), newer: end },
        { id: 'q:q11:0', older: cont(pos('r2')), newer: cont(pos('r3')) },
      ],
      [{ range: 'q:q11:0', units: ['r2', 'r3'].map(unit) }]
    )
  );
  assert.deepEqual(ids(s.items), ['r2', 'stop', 'r3', 'r4']);
});

test('a row that names a record still to arrive waits after the tail and then stands after that record', () => {
  // The reply r4 is shown and not yet stored when the snapshot is taken: its turn's end names it.
  let s = snapshot(['r2', 'r3'], [turnEnd('e4', { shownAfter: pos('r4') })], true);
  assert.deepEqual(ids(s.items), ['r2', 'r3', 'e4']);
  s = at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'insert', after: pos('r3'), unit: unit('r4') } });
  assert.deepEqual(ids(s.items), ['r2', 'r3', 'r4', 'e4']);
  // A tail read anew that keeps the reply keeps its end.
  s = at(s, 'thread/window/changed', changed(11, [{ id: 'tail', older: cont(pos('r4')), newer: end }], [{ range: 'tail', units: [unit('r4')] }]));
  assert.deepEqual(ids(s.items), ['r4', 'e4']);
});

test('the end of a turn stays with its turn: after the record a snapshot names for it, and out of a tail that let its record go', () => {
  // A snapshot taken on the way back to a conversation: the tail's records, and the ends of the turns they hold.
  let s = sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: [turnEnd('e1', { shownAfter: pos('r2') }), turnEnd('e2', { shownAfter: pos('r4') }), turnEnd('e3')],
    hasOlder: true,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: cont(pos('r1')), newer: end }],
      added: [{ range: 'tail', units: ['r1', 'r2', 'r3', 'r4'].map(unit) }],
      followTail: true,
    },
  } as unknown as Json);
  assert.deepEqual(ids(s.items), ['r1', 'r2', 'e1', 'r3', 'r4', 'e2', 'e3']);
  assert.equal(
    s.items.some((row) => 'shownAfter' in row),
    false,
    'where a row stands is not an attribute of the row'
  );

  // The tail is read anew from its newest record: the ends of the turns it let go are of the history above it.
  s = at(s, 'thread/window/changed', changed(11, [{ id: 'tail', older: cont(pos('r4')), newer: end }], [{ range: 'tail', units: [unit('r4')] }]));
  assert.deepEqual(ids(s.items), ['r4', 'e2', 'e3']);

  // A page above joins the tail: the end comes back with the record it follows.
  s = at(
    s,
    'thread/window/changed',
    changed(
      12,
      [
        { id: 'tail', older: cont(pos('r4')), newer: end },
        { id: 'q:q12:0', older: cont(pos('r2')), newer: cont(pos('r4')) },
      ],
      [{ range: 'q:q12:0', units: ['r2', 'r3', 'r4'].map(unit) }]
    )
  );
  assert.deepEqual(ids(s.items), ['r2', 'e1', 'r3', 'r4', 'e2', 'e3']);
});
