// A group room log's `roomView` section (`thread/roomView/updated`) laid over its state reproduces the view Node pushes for the
// room (`agent-room-views.ts` `decorateRoomSnapshot`, `native/core/fixtures/room-approvals/golden.json`, recorded by
// record-room-approvals.mjs): busy, the speaking member's `toolApproval`, the handed-off questions and the typing row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const golden: O = JSON.parse(readFileSync(new URL('../../../native/core/fixtures/room-approvals/golden.json', import.meta.url), 'utf8'));

/** The section the core publishes for a room state (`room_approval::room_view`): what Node's decoration adds. */
function sectionOf(state: O | null, questions: O[], view: O): O | null {
  if (!state) return questions.length ? { busy: false, handoffQuestions: questions } : null;
  const typing = state.speaking ? view.items[view.items.length - 1] : undefined;
  return { busy: true, ...(state.approval ? { toolApproval: state.approval } : {}), ...(typing ? { typing } : {}), ...(questions.length ? { handoffQuestions: questions } : {}) };
}

/** The room log as its own fields give it (the recorded snapshot), with `roomView` set by the live section. */
function fold(snapshot: O, roomView: O | null): SessionFold {
  const base: SessionFold = { sessionId: 'sess_room_room01', items: snapshot.items, fields: { busy: snapshot.busy }, live: null };
  return sessionReducer.apply(base, { method: 'thread/roomView/updated', params: { threadId: 'sess_room_room01', value: roomView } } as never);
}

const pick = (s: O): O => ({ busy: s.busy, toolApproval: s.toolApproval ?? null, handoffQuestions: s.handoffQuestions ?? null, items: s.items });

test('every recorded room state reads as the view Node pushed for the room', () => {
  const cases: O[] = [
    ...(golden.decorations as O[]).map((d) => ({ name: d.name, state: d.state, questions: d.handoffQuestions, snapshot: d.snapshot, view: d.view })),
    ...(golden.cases as O[]).map((c) => ({
      name: c.name,
      state: { speaking: 'gh.bot', speakingName: 'Git Hub', typingId: 'room-typing-n1', approval: c.toolApproval },
      questions: [],
      snapshot: golden.decorations[0].snapshot,
      view: c.roomView,
    })),
  ];
  for (const c of cases) {
    const state = desktopSessionState(fold(c.snapshot, sectionOf(c.state, c.questions, c.view)), []);
    assert.deepEqual(pick(state as O), pick({ toolApproval: null, ...c.view }), c.name);
    assert.equal('roomView' in state, false, `${c.name}: roomView is no state field`);
  }
});

test('a cleared room view leaves the log as its own fields give it', () => {
  const snapshot = golden.decorations[0].snapshot;
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
