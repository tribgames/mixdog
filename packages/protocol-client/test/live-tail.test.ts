// A followed thread's transcript is carried on from the one held: a row that lands changes the cards from its own run on,
// and the reader is told which leading rows are the ones it holds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { mergeToolRows, rowsHeldFrom } from '../src/rows.ts';
import { desktopSessionState, sessionReducer, type SessionFold } from '../src/session-state.ts';

const apply = (fold: SessionFold, item: Obj): SessionFold =>
  sessionReducer.apply(fold, { jsonrpc: '2.0', method: 'item/completed', params: { threadId: 't', item } } as never);
const shown = (fold: SessionFold): Obj[] => desktopSessionState(fold, []).items as Obj[];
const empty = (): SessionFold => sessionReducer.initial({ thread: { id: 't' }, state: {}, items: [] });
const user = (id: string): Obj => ({ type: 'userMessage', id, content: [{ type: 'text', text: id }], meta: { at: 1 } });
const reply = (id: string): Obj => ({ type: 'agentMessage', id, text: id, meta: { status: 'completed', at: 2 } });
const open = (id: string, name: string, live: boolean): Obj => ({
  type: 'toolCall',
  id,
  name,
  input: { file_path: `${id}.ts` },
  ...(live ? { run: { callId: `call-${id}`, startedAt: 3, count: 1, completedCount: 0, live: true } } : {}),
  meta: { at: 3 },
});
const closed = (call: Obj, status = 'completed'): Obj => ({
  ...call,
  output: `out ${String(call.id)}`,
  ...(call.run
    ? { run: { ...(call.run as Obj), result: `out ${String(call.id)}`, completedAt: 4, completedCount: 1 } }
    : {}),
  meta: { ...(call.meta as Obj), status },
});

test('a transcript carried on from the one held is the transcript merged whole, after every row', () => {
  let seed = 7;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  let fold = empty();
  const running: Obj[] = [];
  let next = 0;
  for (let step = 0; step < 600; step += 1) {
    const roll = random();
    let item: Obj;
    if (roll < 0.12) item = user(`u${next++}`);
    else if (roll < 0.24) item = reply(`a${next++}`);
    else if (roll < 0.28) item = { type: 'turnEnd', id: `e${next++}`, status: 'done', elapsedMs: 1, meta: { at: 5 } };
    else if (roll < 0.32) item = { type: 'reasoning', id: `r${next++}`, summary: [], content: [], meta: {} };
    else if (roll < 0.62 || running.length === 0) {
      item = open(`t${next++}`, random() < 0.7 ? 'read' : random() < 0.5 ? 'shell' : 'agent', random() < 0.7);
      running.push(item);
    } else {
      const [call] = running.splice(Math.floor(random() * running.length), 1);
      item = closed(call!, random() < 0.1 ? 'interrupted' : 'completed');
    }
    fold = apply(fold, item);
    assert.deepEqual(
      shown(fold),
      mergeToolRows(fold.items),
      `after step ${step} (${String(item.type)} ${String(item.id)})`
    );
  }
  assert.ok(shown(fold).some((row) => row.aggregate === true));
});

test('the recorded live turn carries on to the same cards as a fold of it from nothing', () => {
  const frames = JSON.parse(readFileSync(new URL('live-turn-items.json', import.meta.url), 'utf8')) as {
    method: string;
    params: Obj;
  }[];
  let fold = empty();
  for (const frame of frames) {
    fold = sessionReducer.apply(fold, { jsonrpc: '2.0', ...frame } as never);
    assert.deepEqual(shown(fold), mergeToolRows(fold.items));
  }
});

test('a reader is told which leading rows of a transcript are the rows of the one it holds', () => {
  let fold = empty();
  for (const id of ['1', '2', '3']) fold = apply(apply(fold, user(`u${id}`)), reply(`a${id}`));
  const held = shown(fold);
  const call = open('t1', 'read', true);
  let later = apply(fold, call);
  assert.equal(rowsHeldFrom(shown(later), held), held.length, 'a row appended after a reply leaves every row held');
  // Steps the reader never saw are counted too: the rows held are the fewest any of them kept.
  later = apply(apply(later, closed(call)), reply('a4'));
  const rows = shown(later);
  const kept = rowsHeldFrom(rows, held);
  assert.equal(kept, held.length);
  for (let index = 0; index < kept!; index += 1) assert.equal(rows[index], held[index]);
  // A row replaced inside the list is where the rows held end.
  const edited = apply(later, { ...reply('a2'), text: 'edited' });
  const editedRows = shown(edited);
  const editedKept = rowsHeldFrom(editedRows, rows)!;
  assert.ok(editedKept <= 3, 'no row at or after the one replaced is said to be held');
  for (let index = 0; index < editedKept; index += 1) assert.equal(editedRows[index], rows[index]);
  assert.equal(editedRows[3]!.text, 'edited');
  // Another fold of the same thread is not this list carried on.
  assert.equal(
    rowsHeldFrom(shown(sessionReducer.initial({ thread: { id: 't' }, state: {}, items: [] })), held),
    undefined
  );
});

test('a prompt the core shows again replaces the row of its id where it is, however long the fold has run', () => {
  let fold = empty();
  for (let turn = 0; turn < 40; turn += 1) {
    fold = apply(fold, user(`u${turn}`));
    for (let call = 0; call < 12; call += 1) fold = apply(fold, closed(open(`t${turn}-${call}`, 'read', false)));
    fold = apply(fold, reply(`a${turn}`));
  }
  const held = shown(fold);
  const amended = apply(fold, { ...user('u0'), content: [{ type: 'text', text: 'amended' }] });
  const rows = shown(amended);
  assert.equal(amended.items.length, fold.items.length, 'the fold holds every row it was sent: none is added');
  assert.deepEqual(rows, mergeToolRows(amended.items));
  assert.equal(rows.length, held.length);
  assert.equal(rows[0]!.text, 'amended');
  assert.equal(rows.filter((row) => row.id === 'u0').length, 1);
  assert.equal(rowsHeldFrom(rows, held) ?? 0, 0, 'no row at or after the amended one is said to be held');
});

test('a compaction that re-sends every row it archived is one merge, at the next read', () => {
  let fold = empty();
  for (let turn = 0; turn < 200; turn += 1) fold = apply(apply(fold, user(`u${turn}`)), reply(`a${turn}`));
  const held = shown(fold);
  // More rows than the merge steps a reader can be behind by (rows.ts MERGE_LINE_STEPS): a merge per notification would
  // leave the reader not knowing which rows it still holds.
  for (let turn = 20; turn < 180; turn += 1) {
    for (const item of [user(`u${turn}`), reply(`a${turn}`)])
      fold = apply(fold, { ...item, meta: { ...(item.meta as Obj), ext: { archived: true } } });
  }
  const rows = shown(fold);
  assert.deepEqual(rows, mergeToolRows(fold.items));
  assert.equal(rows[40]!.archived, true);
  const kept = rowsHeldFrom(rows, held);
  assert.equal(kept, 40, 'the rows above the first one archived are the rows held');
  for (let index = 0; index < 40; index += 1) assert.equal(rows[index], held[index]);
});
