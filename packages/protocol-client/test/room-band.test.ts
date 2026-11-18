// A group room's "who is typing" band, revision by revision. The core publishes a member's words together with the end of its
// typing (`item/completed.roomView`: one notification, so one revision), a turn that leaves no row as a view alone, and the
// room deciding who speaks next as the band's hand-off row. The shared reducer folds each notification before anyone is told, so
// every state a subscriber sees (the desktop reads each change; the phone reads one per `thread/frame`) has rows and band that
// belong together, and a snapshot taken at any boundary reads as the live fold does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolClient } from '../src/api.ts';
import { desktopSessionState, sessionReducer, subscribeFramedSessionStates } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const T = 'sess_room_room01';

const typingRow = (id: string, speaker: string): O => ({ kind: 'notice', id, tone: 'info', text: `${speaker}…`, room: { kind: 'typing', speaker, name: speaker.toUpperCase() } });
const decidingRow: O = { kind: 'notice', id: 'room-deciding', tone: 'info', text: '…', room: { kind: 'typing', speaker: '', name: '' } };
const typing = (id: string, speaker: string): O => ({ busy: true, typing: typingRow(id, speaker) });
const deciding: O = { busy: true, deciding: true, typing: decidingRow };

const item = (id: string): O => ({ type: 'agentMessage', id, text: `words ${id}`, meta: {} });
/** `roomView` absent: the view stands; `null`: the room shows no activity (the clear travels with its row). */
const landed = (id: string, roomView?: O | null): O => ({ method: 'item/completed', params: { threadId: T, turnId: '', item: item(id), ...(roomView !== undefined ? { roomView } : {}) } });
const view = (value: O | null): O => ({ method: 'thread/roomView/updated', params: { threadId: T, value } });
const frame = (structureChanged: boolean): O => ({ method: 'thread/frame', params: { threadId: T, structureChanged } });

const snapshot = (ids: string[], roomView: O | null): O => ({ thread: { id: T }, state: roomView ? { roomView } : {}, items: ids.map(item), hasOlder: false });

/** `rows | band`: the transcript rows, then who types (`…` while the room decides, `-` when nobody). */
function shown(state: O): string {
  const items = state.items as O[];
  const last = items.at(-1);
  const band = last?.kind === 'notice' && last.room?.kind === 'typing' ? last.room.speaker || '…' : '-';
  const rows = items.filter((row) => !(row.kind === 'notice' && row.room?.kind === 'typing')).map((row) => row.id);
  return `${rows.join(',')} | ${band}`.trim();
}

/** What the core's room log is at each boundary: rows and view. The notification that moves from one to the next. */
interface Step {
  note: O;
  rows: string[];
  roomView: O | null;
}

/** One client: its store folds each notification with the shared reducer and tells its subscribers once. */
function clientOf(initial: O) {
  const listeners = new Set<(change: O) => void>();
  let fold: SessionFold = sessionReducer.initial(initial as never);
  const store = {
    thread: () => ({ feed: { id: T, epoch: 'e', seq: 1 }, order: 1, state: fold }),
    section: () => undefined,
    subscribe: (listener: (change: O) => void) => (listeners.add(listener), () => listeners.delete(listener)),
  };
  const client = { store, pendingServerRequests: () => [] } as unknown as ProtocolClient<SessionFold>;
  return {
    client,
    feed(note: O): void {
      fold = sessionReducer.apply(fold, note as never);
      for (const listener of [...listeners]) listener({ type: 'thread', threadId: T });
    },
    state: (): O => desktopSessionState(fold, []) as O,
  };
}

/** The desktop's view: every change. */
function everyChange(steps: Step[], start: O = snapshot(['u1'], null)): string[] {
  const seen: string[] = [];
  const room = clientOf(start);
  room.client.store.subscribe(() => seen.push(shown(room.state())));
  for (const step of steps) room.feed(step.note);
  return seen;
}

const exchange = (): Step[] => [
  { note: view(deciding), rows: ['u1'], roomView: deciding },
  { note: view(typing('t1', 'a')), rows: ['u1'], roomView: typing('t1', 'a') },
  { note: landed('a1', deciding), rows: ['u1', 'a1'], roomView: deciding },
  { note: view(typing('t2', 'b')), rows: ['u1', 'a1'], roomView: typing('t2', 'b') },
  { note: landed('b1', deciding), rows: ['u1', 'a1', 'b1'], roomView: deciding },
  { note: view(null), rows: ['u1', 'a1', 'b1'], roomView: null },
];

test('a plain send after a finished exchange: each speaker is replaced by the hand-off band, never by a gap', () => {
  assert.deepEqual(everyChange(exchange()), ['u1 | …', 'u1 | a', 'u1,a1 | …', 'u1,a1 | b', 'u1,a1,b1 | …', 'u1,a1,b1 | -']);
});

test('a send queued while the room answers: the cut-short member is retired with no row and the band stays until the next speaker', () => {
  const steps: Step[] = [
    { note: view(typing('t1', 'b')), rows: ['u1'], roomView: typing('t1', 'b') },
    { note: landed('u2', typing('t1', 'b')), rows: ['u1', 'u2'], roomView: typing('t1', 'b') },
    { note: view(deciding), rows: ['u1', 'u2'], roomView: deciding },
    { note: view(typing('t2', 'a')), rows: ['u1', 'u2'], roomView: typing('t2', 'a') },
  ];
  assert.deepEqual(everyChange(steps), ['u1 | b', 'u1,u2 | b', 'u1,u2 | …', 'u1,u2 | a']);
});

test('the same speaker twice in a row, with coalesced views: its words end its typing in the same state, and a repeated view changes nothing', () => {
  const steps: Step[] = [
    { note: view(typing('t1', 'a')), rows: ['u1'], roomView: typing('t1', 'a') },
    { note: landed('a1', deciding), rows: ['u1', 'a1'], roomView: deciding },
    { note: view(deciding), rows: ['u1', 'a1'], roomView: deciding },
    { note: view(deciding), rows: ['u1', 'a1'], roomView: deciding },
    { note: view(typing('t3', 'a')), rows: ['u1', 'a1'], roomView: typing('t3', 'a') },
  ];
  assert.deepEqual(everyChange(steps), ['u1 | a', 'u1,a1 | …', 'u1,a1 | …', 'u1,a1 | …', 'u1,a1 | a']);
});

test('a turn cut short without a row ends its typing as a view of its own', () => {
  assert.deepEqual(
    everyChange([
      { note: view(typing('t1', 'a')), rows: ['u1'], roomView: typing('t1', 'a') },
      { note: view(deciding), rows: ['u1'], roomView: deciding },
      { note: view(null), rows: ['u1'], roomView: null },
    ]),
    ['u1 | a', 'u1 | …', 'u1 | -']
  );
});

test('a send landing after the exchange ended carries the clear with its row: one state, live and in a snapshot', () => {
  const steps: Step[] = [
    { note: landed('a1', deciding), rows: ['u1', 'a1'], roomView: deciding },
    { note: landed('u3', null), rows: ['u1', 'a1', 'u3'], roomView: null },
    // The publication that follows changes nothing.
    { note: view(null), rows: ['u1', 'a1', 'u3'], roomView: null },
  ];
  assert.deepEqual(everyChange(steps), ['u1,a1 | …', 'u1,a1,u3 | -', 'u1,a1,u3 | -']);
  const live = clientOf(snapshot(['u1'], null));
  for (const step of steps) {
    live.feed(step.note);
    const again = desktopSessionState(sessionReducer.initial(snapshot(step.rows, step.roomView) as never), []) as O;
    assert.equal(shown(again), shown(live.state()));
    assert.equal(again.busy ?? false, live.state().busy ?? false);
  }
  // An absent `roomView` is not a clear.
  const kept = clientOf(snapshot(['u1'], deciding));
  kept.feed(landed('u2'));
  assert.equal(shown(kept.state()), 'u1,u2 | …');
});

test('a history reset keeps the room\'s activity: the rows are cut back and the band stands', () => {
  const room = clientOf(snapshot(['u1', 'a1'], typing('t1', 'b')));
  room.feed({ method: 'thread/historyReset', params: { threadId: T, fromItemId: 'u1' } });
  assert.equal(shown(room.state()), 'u1 | b');
  room.feed(landed('b1', deciding));
  assert.equal(shown(room.state()), 'u1,b1 | …');
});

test('a snapshot at every boundary reads as the live fold does (reconnect needs no remembered state)', () => {
  const steps = exchange();
  const live = clientOf(snapshot(['u1'], null));
  steps.forEach((step, index) => {
    live.feed(step.note);
    const again = desktopSessionState(sessionReducer.initial(snapshot(step.rows, step.roomView) as never), []) as O;
    assert.equal(shown(again), shown(live.state()), `boundary ${index}`);
    assert.equal(again.busy ?? false, live.state().busy ?? false, `boundary ${index}: busy`);
  });
});

test('the phone reads one state per frame, each with rows and band together', () => {
  const room = clientOf(snapshot(['u1'], null));
  const framed: string[] = [];
  subscribeFramedSessionStates(room.client, () => T, (_id, state) => framed.push(shown(state as O)));
  // The first fold of the thread.
  room.feed(frame(false));
  // The core announces a frame after each transition; a row and the view it landed with are one notification of it.
  for (const step of exchange()) {
    room.feed(step.note);
    room.feed(frame(step.note.method === 'item/completed'));
  }
  assert.deepEqual(framed, ['u1 | -', 'u1 | …', 'u1 | a', 'u1,a1 | …', 'u1,a1 | b', 'u1,a1,b1 | …', 'u1,a1,b1 | -']);
});
