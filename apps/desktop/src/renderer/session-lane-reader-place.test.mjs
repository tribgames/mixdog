import assert from 'node:assert/strict';
import test from 'node:test';
import { setHistoryPositions } from '../../../../packages/protocol-client/src/rows.ts';
import { createSessionLaneStore, HIDDEN_SESSION_ROW_BUDGET } from './session-lane-store.ts';
import {
  holdsReaderTop,
  keepReaderPlaces,
  noteReaderPlaced,
  openReaderPlace,
  pendingReaderPlace,
  readerPlace,
  readerPlaceCount,
  voidReaderPlace,
} from './transcript-list-reader-place.ts';

const tabs = (entries) => new Map(Object.entries(entries).map(([pane, sessions]) => [pane, new Set(sessions)]));
const rows = (count, from = 0) =>
  Array.from({ length: count }, (_, n) => {
    const id = `r${from + n}`;
    return setHistoryPositions({ id, kind: 'assistant', text: id }, `p:${id}`, `p:${id}`);
  });
const positioned = (sessionId, items, extra = {}) => ({
  sessionId,
  snapshot: { sessionId, items, transcriptPositioned: true, transcriptWindowVersion: 1, ...extra },
  frameSource: 'live',
});

test("a reader's place is its pane's: two panes on one session keep one each, and a place outlives any number of other sessions", () => {
  keepReaderPlaces(tabs({ one: ['s', ...Array.from({ length: 200 }, (_, n) => `x${n}`)], two: ['s'] }));
  openReaderPlace('one', 's', { position: 'p:r10', top: -40 });
  openReaderPlace('two', 's', { position: 'p:r90', top: 12 });
  for (let n = 0; n < 200; n += 1) openReaderPlace('one', `x${n}`, { position: `p:x${n}`, top: 0 });
  assert.deepEqual(readerPlace('one', 's'), { position: 'p:r10', top: -40 });
  assert.deepEqual(pendingReaderPlace('two', 's'), { position: 'p:r90', top: 12 });
  assert.equal(readerPlaceCount(), 202);
  keepReaderPlaces(tabs({}));
});

test('a place lives as long as its pane holds a tab of the session, and a save that arrives after is dropped', () => {
  keepReaderPlaces(tabs({ one: ['s', 't'] }));
  openReaderPlace('one', 's', { position: 'p:r10', top: 0 });
  openReaderPlace('one', 't', { position: 'p:r20', top: 0 });
  keepReaderPlaces(tabs({ one: ['t'] }));
  assert.equal(readerPlace('one', 's'), null, 'the tab was closed: its place went with it');
  assert.deepEqual(readerPlace('one', 't'), { position: 'p:r20', top: 0 });
  openReaderPlace('one', 's', { position: 'p:r10', top: 0 });
  assert.equal(readerPlace('one', 's'), null, 'a save of the place let go');
  voidReaderPlace('one', 't');
  assert.equal(readerPlace('one', 't'), null, 'a record the history no longer holds leaves the reader at the end');
  keepReaderPlaces(tabs({}));
});

test('the row a list put its reader on keeps its top while it crosses the top of the view: its size settling is not compensated at its lower edge', () => {
  const list = {};
  const row = { key: 'r7', start: 700, end: 838 };
  assert.equal(holdsReaderTop(list, row, 811), false, 'no reader was put on it');
  noteReaderPlaced(list, 'r7');
  assert.equal(holdsReaderTop(list, { key: 'r6', start: 600, end: 700 }, 811), false, 'another row');
  assert.equal(holdsReaderTop(list, row, 811), true, 'the reader is 111px into the row');
  assert.equal(holdsReaderTop({}, row, 811), false, 'another list');
  // The reader scrolled on: the row is above the view, and is a row like any other from then on.
  assert.equal(holdsReaderTop(list, row, 900), false);
  assert.equal(holdsReaderTop(list, row, 811), false, 'also when it is back under the top of the view');
});

test('a surface outside the panes keeps no place', () => {
  openReaderPlace('', 's', { position: 'p:r10', top: 0 });
  assert.equal(readerPlace('', 's'), null);
});

test('a read of a shown session (its newest rows, no window) never takes the place of the window its subscription held', () => {
  const store = createSessionLaneStore();
  store.setShownSessionIds(['s']);
  const window_ = rows(40, 100);
  store.apply(positioned('s', window_));
  store.apply({ sessionId: 's', snapshot: { sessionId: 's', items: rows(10, 290) }, frameSource: 'replay' });
  assert.equal(store.get('s').items.length, 40, 'the window stands');
  assert.equal(store.get('s').transcriptPositioned, true);
  // No pane shows it: a read is the freshest there is.
  store.setShownSessionIds([]);
  store.apply({ sessionId: 's', snapshot: { sessionId: 's', items: rows(10, 290) }, frameSource: 'replay' });
  assert.equal(store.get('s').items.length, 10);
});

test('rows of sessions no pane shows are kept for an entry at their end: none without a tab, the tail within the budget, none beyond it, wherever a reader was', () => {
  const store = createSessionLaneStore();
  keepReaderPlaces(tabs({ one: ['end', 'read'] }));
  store.apply(positioned('closed', rows(50)));
  store.apply(positioned('end', rows(200)));
  store.apply(positioned('read', rows(800)));
  openReaderPlace('one', 'read', { position: 'p:r500', top: 0 });
  assert.equal(store.hiddenRows(), 1050);
  store.sweepHidden();
  assert.equal(store.get('closed'), null, 'no pane holds a tab of it');
  assert.equal(store.get('end').items.length, 200, 'the rows held fit the budget');
  assert.equal(
    store.get('read'),
    null,
    `a tail of more than ${HIDDEN_SESSION_ROW_BUDGET} rows is read again, a reader's place in it or not`
  );
  assert.equal(store.hiddenRows(), 200);
  // A session a pane shows is not swept.
  const off = store.subscribe('shown', () => {});
  store.apply(positioned('shown', rows(900)));
  store.sweepHidden();
  assert.equal(store.get('shown').items.length, 900);
  off();
  keepReaderPlaces(tabs({}));
});
