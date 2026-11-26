// A tool card is in the transcript the moment its call shows, running, after the text that preceded it; its result closes the same card
// (same id, same place); a call the Stop ended closes as stopped; a reopened window holds the stored rows as the same cards.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

const T = 'turn-1';
const text = (id: string, body: string): Obj => ({ type: 'agentMessage', id, text: body, meta: { turnId: T, at: 1 } });
const open = (id: string, callId: string, name: string, input: Obj): Obj => ({
  type: 'toolCall',
  id,
  name,
  input,
  run: { callId, startedAt: 2, count: 1, completedCount: 0, live: true },
  meta: { turnId: T, at: 2 },
});
const closed = (call: Obj, output: string, status = 'completed'): Obj => ({
  ...call,
  output,
  run: { ...(call.run as Obj), result: output, completedAt: 3, completedCount: 1 },
  meta: { ...(call.meta as Obj), status },
});

const fold = (items: Obj[]) => {
  let state = sessionReducer.initial({ thread: { id: 'thread' }, state: {}, items: [] });
  const shots: Obj[][] = [];
  for (const item of items) {
    state = sessionReducer.apply(state, {
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId: 'thread', turnId: T, item },
    } as never);
    shots.push(desktopSessionState(state, []).items as Obj[]);
  }
  return shots;
};
const cards = (rows: Obj[]) => rows.filter((row) => row.kind === 'tool');

test('a call shows as a running card after its preceding text, and its result closes that card in place', () => {
  const call = open('itm_b', 'c1', 'shell', { command: 'ls' });
  const [afterText, running, done] = fold([text('itm_a', 'looking'), call, closed(call, 'ok')]);
  assert.equal(cards(afterText!).length, 0);
  assert.deepEqual(
    running!.map((row) => row.kind),
    ['assistant', 'tool']
  );
  assert.equal(running![1]!.completedCount, 0);
  const [member] = running![1]!.toolMembers as Obj[];
  assert.deepEqual([member!.name, member!.args, member!.result], ['shell', { command: 'ls' }, null]);
  assert.deepEqual(
    done!.map((row) => [row.kind, row.id]),
    [
      ['assistant', 'itm_a'],
      ['tool', running![1]!.id],
    ]
  );
  assert.equal(done![1]!.completedCount, 1);
});

test('two calls keep the order they were issued while their results land in the other order', () => {
  const a = open('itm_b', 'c1', 'shell', { command: 'a' });
  const b = open('itm_c', 'c2', 'agent', { type: 'spawn' });
  const [first, both, bDone, aDone] = fold([a, b, closed(b, 'B'), closed(a, 'A')]);
  const state = (rows: Obj[]) => cards(rows).map((row) => [row.id, row.completedCount]);
  assert.deepEqual(state(first!), [['itm_b', 0]]);
  assert.deepEqual(state(both!), [
    ['itm_b', 0],
    ['itm_c', 0],
  ]);
  // The agent call's result came first: its card closed, in its place after the earlier call's, which is still running.
  assert.deepEqual(state(bDone!), [
    ['itm_b', 0],
    ['itm_c', 1],
  ]);
  assert.deepEqual(state(aDone!), [
    ['itm_b', 1],
    ['itm_c', 1],
  ]);
});

test('a call the Stop ended closes as stopped, in the same card', () => {
  const call = open('itm_b', 'c1', 'shell', { command: 'sleep 9' });
  const [running, stopped] = fold([
    call,
    {
      ...closed(call, 'Error: aborted', 'interrupted'),
      run: { ...(closed(call, 'x').run as Obj), result: 'Error: aborted', isError: true },
    },
  ]);
  assert.equal(running![0]!.id, stopped![0]!.id);
  assert.equal(stopped![0]!.completedCount, 1);
  assert.equal(stopped![0]!.isError, true);
});

test('the stored rows of the same call (a reopened window) are the same card in the same place', () => {
  const call = open('itm_b', 'c1', 'shell', { command: 'ls' });
  const live = fold([text('itm_a', 'looking'), call, closed(call, 'ok')]).at(-1)!;
  const stored = (item: Obj): Obj => ({ ...item, run: { ...(item.run as Obj), live: undefined } });
  const reopened = fold([text('itm_a', 'looking'), stored(closed(call, 'ok'))]).at(-1)!;
  assert.deepEqual(
    reopened.map((row) => [row.kind, row.id]),
    live.map((row) => [row.kind, row.id])
  );
});

test('tool rows from item/started, item/completed, and snapshot preserve turnId across standalone and aggregate cards', () => {
  let state = sessionReducer.initial({ thread: { id: 'thread' }, state: {}, items: [] });
  // item/started with turnId only on notification params (not inside item.meta)
  state = sessionReducer.apply(state, {
    jsonrpc: '2.0',
    method: 'item/started',
    params: {
      threadId: 'thread',
      turnId: 'turn-wake-2',
      item: {
        type: 'toolCall',
        id: 'itm_start',
        name: 'edit',
        input: { file_path: 'src/b.ts' },
        run: { callId: 'c-start', startedAt: 10, count: 1, completedCount: 0, live: true },
        meta: { at: 10 },
      },
    },
  } as never);
  const startedRows = desktopSessionState(state, []).items as Obj[];
  assert.equal(startedRows.length, 1);
  assert.equal(startedRows[0]?.turnId, 'turn-wake-2', 'item/started aggregate tool row carries params.turnId');

  // item/completed closes the same live aggregate card and keeps turnId
  state = sessionReducer.apply(state, {
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn-wake-2',
      item: {
        type: 'toolCall',
        id: 'itm_start',
        name: 'edit',
        input: { file_path: 'src/b.ts' },
        output: 'ok',
        run: {
          callId: 'c-start',
          result: 'ok',
          startedAt: 10,
          completedAt: 12,
          count: 1,
          completedCount: 1,
          live: true,
        },
        meta: { turnId: 'turn-wake-2', at: 10, status: 'completed' },
      },
    },
  } as never);
  const completedRows = desktopSessionState(state, []).items as Obj[];
  assert.equal(completedRows.length, 1);
  assert.equal(completedRows[0]?.turnId, 'turn-wake-2', 'item/completed aggregate tool row carries turnId');

  // Snapshot items preserve meta.turnId on both standalone and restored aggregate tool rows
  const snap = sessionReducer.initial({
    thread: { id: 'thread' },
    state: {},
    items: [
      {
        type: 'toolCall',
        id: 'itm_snap_1',
        name: 'read',
        input: { file_path: 'a.ts' },
        output: 'one',
        meta: { turnId: 'turn-snap-1', status: 'completed', at: 1 },
      },
      {
        type: 'toolCall',
        id: 'itm_snap_2',
        name: 'read',
        input: { file_path: 'b.ts' },
        output: 'two',
        meta: { turnId: 'turn-snap-1', status: 'completed', at: 2 },
      },
      {
        type: 'toolCall',
        id: 'itm_snap_3',
        name: 'read',
        input: { file_path: 'c.ts' },
        output: 'three',
        meta: { turnId: 'turn-snap-2', status: 'completed', at: 3 },
      },
    ],
  });
  const snapRows = desktopSessionState(snap, []).items as Obj[];
  assert.deepEqual(
    snapRows.map((row) => [row.id, row.name, row.turnId]),
    [
      ['itm_snap_1', '__aggregate__', 'turn-snap-1'],
      ['itm_snap_3', 'read', 'turn-snap-2'],
    ],
    'snapshot tool rows preserve meta.turnId and do not merge across distinct turns'
  );
});

test('item/agentMessage/delta restores turnId on a snapshot-restored untagged live row', () => {
  let state = sessionReducer.initial({
    thread: { id: 'thread' },
    state: {},
    items: [
      {
        type: 'agentMessage',
        id: 'itm_live',
        text: 'Hello',
        meta: { status: 'inProgress', at: 10 },
      },
    ],
  });
  const before = desktopSessionState(state, []);
  assert.equal(
    ((before.streamingPartial as Obj | undefined)?.tail as Obj | undefined)?.turnId,
    undefined,
    'snapshot live starts untagged'
  );

  // First delta attaches turnId onto existing untagged live row (partial only).
  state = sessionReducer.apply(state, {
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 't2', itemId: 'itm_live', delta: ' world' },
  } as never);
  const afterPartial = desktopSessionState(state, []);
  assert.equal(
    ((afterPartial.streamingPartial as Obj | undefined)?.tail as Obj | undefined)?.turnId,
    't2',
    'delta restores turnId on snapshot-restored live partial'
  );

  // Subsequent delta with a newline promotes into streamingTail keeping turnId.
  state = sessionReducer.apply(state, {
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 't2', itemId: 'itm_live', delta: '\nnext' },
  } as never);
  const afterTail = desktopSessionState(state, []);
  assert.equal((afterTail.streamingTail as Obj | undefined)?.turnId, 't2', 'streamingTail preserves restored turnId');
});
