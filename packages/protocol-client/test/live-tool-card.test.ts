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
