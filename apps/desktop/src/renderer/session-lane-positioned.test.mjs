// A positioned window lets go of rows: the lane shows what the window holds, never the rows it released above the tail.
import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopSessionState, sessionReducer } from '../../../../packages/protocol-client/src/session-state.ts';
import { createSessionLaneStore } from './session-lane-store.ts';
import { createTranscriptSnapshotDecorator } from './snapshot-transcript-decoration.ts';

const pos = (id) => `h1:0:${id}`;
const unit = (id) => ({
  position: pos(id),
  items: [
    { type: 'userMessage', id, content: [{ type: 'text', text: id }], meta: { ext: { historyPosition: pos(id) } } },
  ],
});
const tail = (ids) => ({ range: 'tail', units: ids.map(unit) });
const cont = (id) => ({ kind: 'continuation', position: pos(id) });

test('the tail read anew shows only the rows it holds; the rows released above it are not kept', () => {
  const sessionId = 's';
  const store = createSessionLaneStore({ decorator: createTranscriptSnapshotDecorator({ register: false }) });
  let fold = sessionReducer.initial({
    thread: { id: sessionId },
    state: {},
    items: [],
    hasOlder: true,
    window: {
      windowVersion: 1,
      lineage: 0,
      ranges: [{ id: 'tail', older: cont('r1'), newer: { kind: 'end' } }],
      added: [tail(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])],
      followTail: true,
    },
  });
  const publish = () => store.apply({ sessionId, frameSource: 'live', snapshot: desktopSessionState(fold, []) });
  const ids = () => store.get(sessionId).items.map((item) => String(item.id));
  publish();
  assert.deepEqual(ids(), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
  fold = sessionReducer.apply(fold, {
    method: 'thread/window/changed',
    params: {
      threadId: sessionId,
      subscriptionId: 'sub',
      requestId: 'q',
      windowVersion: 2,
      lineage: 0,
      atFeedPosition: { epoch: 'e', seq: 9 },
      ranges: [{ id: 'tail', older: cont('r5'), newer: { kind: 'end' } }],
      removed: [],
      added: [tail(['r5', 'r6', 'r7'])],
      followTail: true,
    },
  });
  publish();
  assert.deepEqual(ids(), ['r5', 'r6', 'r7']);
});

test('the window of a session followed again replaces the rows the lane showed: none is kept above it', () => {
  const sessionId = 's';
  const store = createSessionLaneStore({ decorator: createTranscriptSnapshotDecorator({ register: false }) });
  const snapshot = (ids, version = 1) =>
    sessionReducer.initial({
      thread: { id: sessionId },
      state: {},
      items: [],
      hasOlder: true,
      window: {
        windowVersion: version,
        lineage: 0,
        ranges: [{ id: 'tail', older: cont(ids[0]), newer: { kind: 'end' } }],
        added: [tail(ids)],
        followTail: true,
      },
    });
  const publish = (fold) => store.apply({ sessionId, frameSource: 'live', snapshot: desktopSessionState(fold, []) });
  const ids = () => store.get(sessionId).items.map((item) => String(item.id));
  const release = store.subscribe(sessionId, () => {});
  store.setShownSessionIds([sessionId]);
  publish(snapshot(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']));
  const shown = store.get(sessionId).items;
  // The session leaves the screen and its thread is let go; shown again, the thread is followed from the default tail.
  store.setShownSessionIds([]);
  store.setShownSessionIds([sessionId]);
  publish(snapshot(['r5', 'r6', 'r7']));
  assert.deepEqual(ids(), ['r5', 'r6', 'r7'], 'the lane holds what the window states, and no row of the one before');
  assert.equal(store.get(sessionId).items[0], shown[4], 'a row both hold is the object the pane has');
  release();
  store.clear();
});

test('the lane holds the rows of the fold that shows them: a record stored or read again brings no second row', () => {
  const sessionId = 's';
  const store = createSessionLaneStore({ decorator: createTranscriptSnapshotDecorator({ register: false }) });
  const frame = (value) => JSON.parse(JSON.stringify(value));
  const at = (fold, method, params) =>
    sessionReducer.apply(fold, frame({ method, params: { threadId: sessionId, ...params } }));
  const call = (id, stored) => ({
    type: 'toolCall',
    id,
    name: 'read',
    input: { file_path: `${id}.ts` },
    output: `out ${id}`,
    meta: { status: 'completed', ...(stored ? { ext: { historyPosition: pos(id) } } : {}) },
  });
  const calls = ['t1', 't2', 't3'];
  let fold = sessionReducer.initial({
    thread: { id: sessionId },
    state: {},
    items: [],
    hasOlder: true,
    window: {
      windowVersion: 1,
      lineage: 0,
      ranges: [{ id: 'tail', older: cont('r1'), newer: { kind: 'end' } }],
      added: [tail(['r1', 'r2'])],
      followTail: true,
    },
  });
  const release = store.subscribe(sessionId, () => {});
  store.setShownSessionIds([sessionId]);
  const publish = () => store.apply({ sessionId, frameSource: 'live', snapshot: desktopSessionState(fold, []) });
  /** Every row the lane shows is the row the fold's transcript holds in that place. */
  const sharesRows = (label) => {
    const lane = store.get(sessionId).items;
    const held = desktopSessionState(fold, []).items;
    assert.equal(lane.length, held.length, label);
    for (const [index, row] of lane.entries())
      assert.equal(row, held[index], `${label}: row ${index} (${row.id}) is the fold's`);
  };
  publish();
  // The turn's calls end, each shown before its record is stored.
  for (const id of calls) {
    fold = at(fold, 'item/completed', { item: call(id, false) });
    publish();
  }
  let after = 'r2';
  for (const id of calls) {
    fold = at(fold, 'thread/transcript/changed', {
      lineage: 0,
      change: { op: 'insert', after: pos(after), unit: { position: pos(id), items: [call(id, true)] } },
    });
    after = id;
    publish();
  }
  sharesRows('records stored');
  // The window reads the records again.
  fold = at(fold, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: 'q',
    windowVersion: 2,
    lineage: 0,
    atFeedPosition: { epoch: 'e', seq: 9 },
    ranges: [{ id: 'tail', older: cont('r1'), newer: { kind: 'end' } }],
    removed: [],
    added: [
      {
        range: 'tail',
        units: [...['r1', 'r2'].map(unit), ...calls.map((id) => ({ position: pos(id), items: [call(id, true)] }))],
      },
    ],
    followTail: true,
  });
  publish();
  sharesRows('records read again');
  release();
  store.clear();
});
