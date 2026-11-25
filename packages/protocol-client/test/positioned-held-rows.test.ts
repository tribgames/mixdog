// A row is held once: when the core tells a record whose rows the fold already shows (the record stored after its rows
// were shown, a window that reads it again), the fold keeps the rows it shows, so a reader that keeps the rows it has
// holds the fold's own rows and no second copy of them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import type { Obj } from '../src/obj.ts';
import { historyPositionOf } from '../src/rows.ts';
import { desktopSessionState, sessionReducer, type SessionFold } from '../src/session-state.ts';
import { end, pos } from './positioned-fixtures.ts';

/** As a frame arrives: parsed, every value its own. */
const frame = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tool = (index: number, stored: boolean, output = `out ${index}`): Obj => ({
  type: 'toolCall',
  id: `t${index}`,
  name: 'read',
  input: { file_path: `f${index}.ts` },
  output,
  meta: { status: 'completed', ...(stored ? { ext: { historyPosition: pos(`t${index}`) } } : {}) },
});
const at = (s: SessionFold, method: string, params: Obj) =>
  sessionReducer.apply(s, frame({ method, params: { threadId: 't', ...params } }) as never);
const shown = (fold: SessionFold): Obj[] => desktopSessionState(fold, []).items as Obj[];
const first = { type: 'agentMessage', id: 'a0', text: 'a0', meta: { ext: { historyPosition: pos('a0') } } };
const opened = (): SessionFold =>
  sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: [],
    hasOlder: false,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: end, newer: end }],
      added: [{ range: 'tail', units: [{ position: pos('a0'), items: [first] }] }],
      followTail: true,
    },
  } as unknown as Json);
const reread = (fold: SessionFold, version: number, tools: Obj[]) =>
  at(fold, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: `q${version}`,
    windowVersion: version,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: version },
    ranges: [{ id: 'tail', older: end, newer: end }],
    removed: [],
    added: [
      {
        range: 'tail',
        units: [
          { position: pos('a0'), items: [first] },
          ...tools.map((item) => ({ position: pos(String(item.id)), items: [item] })),
        ],
      },
    ],
    followTail: true,
  });

test('a record stored after its rows were shown, and read again by a window, holds the rows shown', () => {
  let fold = opened();
  for (let index = 0; index < 3; index += 1) fold = at(fold, 'item/completed', { item: tool(index, false) });
  const loose = fold.loose ?? [];
  const read = shown(fold);
  assert.equal(loose.length, 3);

  let after = 'a0';
  for (let index = 0; index < 3; index += 1) {
    fold = at(fold, 'thread/transcript/changed', {
      lineage: 1,
      change: { op: 'insert', after: pos(after), unit: { position: pos(`t${index}`), items: [tool(index, true)] } },
    });
    after = `t${index}`;
  }
  assert.equal(fold.loose?.length ?? 0, 0, 'every row shown gave way to its record');
  const stored = shown(fold);
  assert.equal(stored.length, read.length);
  for (const [index, row] of stored.entries())
    assert.equal(row, read[index], `row ${index} is the row the reader was shown`);
  for (let index = 0; index < 3; index += 1) {
    const row = fold.held?.units.get(pos(`t${index}`))?.rows[0];
    assert.equal(row, loose[index], `the record of t${index} holds the row shown for it`);
    assert.equal(historyPositionOf(row), pos(`t${index}`), 'the row shown takes its record’s position');
  }
  const card = stored.at(-1)!;
  assert.deepEqual([historyPositionOf(card), historyPositionOf(card, 'after')], [pos('t0'), pos('t2')]);

  fold = reread(
    fold,
    20,
    [0, 1, 2].map((index) => tool(index, true))
  );
  const again = shown(fold);
  for (const [index, row] of again.entries()) assert.equal(row, read[index], `row ${index} read again is the row held`);

  // A record that reads differently is a row of its own.
  fold = reread(fold, 30, [tool(0, true), tool(1, true, 'changed'), tool(2, true)]);
  const units = fold.held!.units;
  assert.equal(units.get(pos('t0'))?.rows[0], loose[0]);
  assert.notEqual(units.get(pos('t1'))?.rows[0], loose[1]);
  assert.equal(units.get(pos('t1'))?.rows[0]?.result, 'changed');
  assert.equal(units.get(pos('t2'))?.rows[0], loose[2]);
});

test('a card made while its rows were shown stands where they do once their records are stored', () => {
  let fold = opened();
  const reply = (stored: boolean): Obj => ({
    type: 'agentMessage',
    id: 'a1',
    text: 'done',
    meta: stored ? { ext: { historyPosition: pos('a1') } } : {},
  });
  // Both calls and the reply after them are shown before any of their records is stored: the reply ends the card's run.
  fold = at(fold, 'item/completed', { item: tool(0, false) });
  fold = at(fold, 'item/completed', { item: tool(1, false) });
  fold = at(fold, 'item/completed', { item: reply(false) });
  const card = shown(fold).find((row) => row.aggregate === true);
  assert.ok(card, 'the calls show as one card');
  let after = 'a0';
  for (const item of [tool(0, true), tool(1, true), reply(true)]) {
    fold = at(fold, 'thread/transcript/changed', {
      lineage: 1,
      change: { op: 'insert', after: pos(after), unit: { position: pos(String(item.id)), items: [item] } },
    });
    after = String(item.id);
  }
  const stored = shown(fold).find((row) => row.aggregate === true);
  assert.equal(stored, card, 'the card is the one shown');
  assert.deepEqual([historyPositionOf(stored), historyPositionOf(stored, 'after')], [pos('t0'), pos('t1')]);
});
