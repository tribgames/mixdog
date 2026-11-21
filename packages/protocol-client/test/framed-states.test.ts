// The framed states a phone is shown (`subscribeFramedSessionStates`) against the fold's `origin` (`SessionFold.origin`): every
// snapshot's fold is heard, however many frames it and the fold before it counted, and an incremental fold is heard only with a
// frame. Both hold only while the reducer gives each snapshot a fresh `origin` and keeps it through every step.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProtocolClient } from '../src/api.ts';
import { sessionReducer, subscribeFramedSessionStates } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const T = 't1';
const snapshot: O = { thread: { id: T }, state: { title: 'T' }, items: [], hasOlder: false };

function clientOf() {
  const listeners = new Set<(change: O) => void>();
  let fold: SessionFold | undefined;
  let seq = 0;
  const store = {
    thread: () => (fold ? { feed: { id: T, epoch: 'e', seq }, order: 1, state: fold } : undefined),
    section: () => undefined,
    subscribe: (listener: (change: O) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const changed = (): void => {
    for (const listener of [...listeners]) listener({ type: 'thread', threadId: T });
  };
  return {
    client: { store, pendingServerRequests: () => [] } as unknown as ProtocolClient<SessionFold>,
    snapshot(): void {
      seq += 1;
      fold = sessionReducer.initial(snapshot as never);
      changed();
    },
    feed(note: O): void {
      seq += 1;
      fold = sessionReducer.apply(fold!, note as never);
      changed();
    },
  };
}

test('every snapshot fold is a framed state, two zero-frame snapshots in a row included; an incremental fold is one only with a frame', () => {
  const c = clientOf();
  const heard: string[] = [];
  subscribeFramedSessionStates(
    c.client,
    () => undefined,
    (_id, state) => heard.push(String(state.desktopSessionTitle ?? state.title ?? ''))
  );
  c.snapshot();
  assert.equal(heard.length, 1, 'the first fold');
  c.snapshot();
  assert.equal(heard.length, 2, 'a second snapshot with no frame on either fold');
  c.feed({ method: 'thread/name/updated', params: { threadId: T, title: 'Renamed' } });
  assert.equal(heard.length, 2, 'an incremental fold with no frame is not a framed state');
  c.feed({ method: 'thread/frame', params: { threadId: T, structureChanged: false } });
  assert.equal(heard.length, 3, 'the frame publishes the fold');
  c.feed({ method: 'thread/name/updated', params: { threadId: T, title: 'Again' } });
  assert.equal(heard.length, 3);
  c.snapshot();
  assert.equal(heard.length, 4, 'a snapshot after frames');
});

test('a note that schedules no frame and leaves the fold as it was makes the state last heard current at its position', () => {
  const c = clientOf();
  const heard: Array<[O, number]> = [];
  const current: Array<[O, number]> = [];
  subscribeFramedSessionStates(
    c.client,
    () => undefined,
    (_id, state, position) => heard.push([state, position.seq]),
    (_id, state, position) => current.push([state, position.seq])
  );
  c.snapshot();
  c.feed({ method: 'thread/frame', params: { threadId: T, structureChanged: false } });
  assert.deepEqual(
    heard.map(([, seq]) => seq),
    [1, 2]
  );
  // Telemetry the core sends without a frame (phone_frame.rs: stage, model-request, tool-batch): the fold is unchanged.
  c.feed({ method: 'thread/stage/updated', params: { threadId: T, value: { stage: 'requesting' } } });
  assert.equal(heard.length, 2, 'no state is heard: nothing changed');
  assert.deepEqual(
    current.map(([, seq]) => seq),
    [3],
    'the state last heard is current at the note'
  );
  assert.equal(current[0]![0], heard[1]![0], 'handed on as the same state');
  // A change that waits for its frame is not current until the frame publishes it.
  c.feed({ method: 'thread/name/updated', params: { threadId: T, title: 'Renamed' } });
  c.feed({ method: 'thread/stage/updated', params: { threadId: T, value: { stage: 'done' } } });
  assert.equal(current.length, 1);
  c.feed({ method: 'thread/frame', params: { threadId: T, structureChanged: false } });
  assert.deepEqual(
    heard.map(([, seq]) => seq),
    [1, 2, 6]
  );
});
