// A followed positioned thread's transcript is carried on from the one held, as a fold of no window's is: a frame at
// the tail leaves the cards above it as they are, and the reader is told which leading rows it keeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import type { Obj } from '../src/obj.ts';
import { mergeToolRows, rowsHeldFrom } from '../src/rows.ts';
import { desktopSessionState, sessionReducer, type SessionFold } from '../src/session-state.ts';
import { at, end, pos } from './positioned-fixtures.ts';

const reply = (id: string) => ({ type: 'agentMessage', id, text: id, meta: { ext: { historyPosition: pos(id) } } });
const tool = (id: string) => ({
  type: 'toolCall',
  id,
  name: 'read',
  input: { file_path: `${id}.ts` },
  output: `out ${id}`,
  meta: { status: 'completed', ext: { historyPosition: pos(id) } },
});
const shown = (fold: SessionFold): Obj[] => desktopSessionState(fold, []).items as Obj[];

function followed(turns: number): SessionFold {
  const units = [];
  for (let turn = 0; turn < turns; turn += 1) {
    units.push({ position: pos(`a${turn}`), items: [reply(`a${turn}`)] });
    for (const call of ['x', 'y', 'z'])
      units.push({ position: pos(`t${turn}${call}`), items: [tool(`t${turn}${call}`)] });
  }
  // A row that is no tool's ends the last run: every card above it is settled.
  units.push({ position: pos('last'), items: [reply('last')] });
  return sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: [],
    hasOlder: false,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: end, newer: end }],
      added: [{ range: 'tail', units }],
      followTail: true,
    },
  } as unknown as Json);
}

test('a row that lands at the tail of a followed window leaves the reader every row above it', () => {
  let fold = followed(40);
  const held = shown(fold);
  assert.ok(
    held.some((row) => row.aggregate === true),
    'the window shows merged tool cards'
  );

  // The running turn's rows (no stored record holds them yet), then the first of them stored as its unit.
  fold = at(fold, 'item/completed', { item: { type: 'agentMessage', id: 'live1', text: 'live1', meta: {} } });
  const withReply = shown(fold);
  assert.deepEqual(withReply, mergeToolRows(fold.items));
  assert.equal(rowsHeldFrom(withReply, held), held.length, 'a reply after the last record leaves every row held');

  fold = at(fold, 'item/completed', { item: { type: 'toolCall', id: 'live2', name: 'read', input: {}, meta: {} } });
  const withCall = shown(fold);
  assert.deepEqual(withCall, mergeToolRows(fold.items));
  assert.equal(rowsHeldFrom(withCall, held), held.length, 'steps the reader never read are counted too');

  fold = at(fold, 'thread/transcript/changed', {
    lineage: 1,
    change: { op: 'insert', after: pos('last'), unit: { position: pos('live1'), items: [reply('live1')] } },
  });
  const stored = shown(fold);
  assert.deepEqual(stored, mergeToolRows(fold.items));
  const kept = rowsHeldFrom(stored, held);
  assert.equal(kept, held.length, 'a record stored at the tail leaves every row above it held');
  for (let index = 0; index < kept!; index += 1) assert.equal(stored[index], held[index]);
});
