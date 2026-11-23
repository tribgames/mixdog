// A positioned window lets go of rows: the lane shows what the window holds, never the rows it released above the tail.
import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopSessionState, sessionReducer } from '../../../../packages/protocol-client/src/session-state.ts';
import { createSessionLaneStore } from './session-lane-store.ts';
import { createTranscriptSnapshotDecorator } from './snapshot-transcript-decoration.ts';

const pos = (id) => `h1:0:${id}`;
const unit = (id) => ({
  position: pos(id),
  items: [{ type: 'userMessage', id, content: [{ type: 'text', text: id }], meta: { ext: { historyPosition: pos(id) } } }],
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
