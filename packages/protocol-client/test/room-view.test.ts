// A group room log's `roomView` section (`thread/roomView/updated`) laid over its state decorates the room's session state: busy,
// the speaking member's `toolApproval`, the handed-off questions and the typing row (`withRoomView` in session-state.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const snapshotItems = [{ kind: 'user', id: 'u1', text: 'hello room' }, { kind: 'notice', id: 'n1', text: 'Stopped.', tone: 'info' }];
const snapshot: O = { busy: false, items: snapshotItems };
const typing = { kind: 'notice', id: 'room-typing-n1', text: 'Git Hub is typing', tone: 'info' };
const approval = { id: 'ap1', tool: 'shell' };
const questions = [{ id: 'q1', text: 'Which branch?' }];

/** The room log as its own fields give it (the snapshot), with `roomView` set by the live section. */
function fold(snapshot: O, roomView: O | null): SessionFold {
  const base: SessionFold = { sessionId: 'sess_room_room01', items: snapshot.items, fields: { busy: snapshot.busy }, live: null, structureRevision: 0 };
  return sessionReducer.apply(base, { method: 'thread/roomView/updated', params: { threadId: 'sess_room_room01', value: roomView } } as never);
}

const pick = (s: O): O => ({ busy: s.busy, toolApproval: s.toolApproval ?? null, handoffQuestions: s.handoffQuestions ?? null, items: s.items });

test('a room view decorates the log: busy, the speaker\'s approval, handed-off questions and the typing row after the transcript', () => {
  const cases: { name: string; view: O | null; want: O }[] = [
    { name: 'no view', view: null, want: { busy: false, toolApproval: null, handoffQuestions: null, items: snapshotItems } },
    { name: 'busy with the typing row', view: { busy: true, typing }, want: { busy: true, toolApproval: null, handoffQuestions: null, items: [...snapshotItems, typing] } },
    { name: 'busy with an approval and questions', view: { busy: true, toolApproval: approval, typing, handoffQuestions: questions }, want: { busy: true, toolApproval: approval, handoffQuestions: questions, items: [...snapshotItems, typing] } },
    { name: 'questions without an exchange leave busy alone', view: { busy: false, handoffQuestions: questions }, want: { busy: false, toolApproval: null, handoffQuestions: questions, items: snapshotItems } },
    { name: 'a view that is not busy adds no approval or typing row', view: { busy: false, toolApproval: approval, typing }, want: { busy: false, toolApproval: null, handoffQuestions: null, items: snapshotItems } },
  ];
  for (const c of cases) {
    const state = desktopSessionState(fold(snapshot, c.view), []);
    assert.deepEqual(pick(state as O), c.want, c.name);
    assert.equal('roomView' in state, false, `${c.name}: roomView is no state field`);
  }
});

test('a cleared room view leaves the log as its own fields give it', () => {
  const cleared = sessionReducer.apply(fold(snapshot, { busy: true, typing: { kind: 'notice', id: 'x' } }), {
    method: 'thread/roomView/updated',
    params: { threadId: 'sess_room_room01', value: null },
  } as never);
  assert.equal('roomView' in cleared.fields, false);
  const state = desktopSessionState(cleared, []) as O;
  assert.equal(state.busy, snapshot.busy);
  assert.deepEqual(state.items, snapshot.items);
});

test('a snapshot carries the room view as the live section does', () => {
  const roomView = { busy: true, toolApproval: { id: '1' } } as unknown as Json;
  const late = sessionReducer.initial({ thread: { id: 't' }, items: [], state: { roomView }, hasOlder: false } as unknown as Json);
  assert.deepEqual(late.fields.roomView, roomView);
  assert.equal((desktopSessionState(late, []) as O).busy, true);
});
