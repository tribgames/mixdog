// Row parity with the Node product: rows-golden.json holds ThreadItems and the transcript rows Node's own projection
// (restore.mjs `restoreTranscriptItems`, agent-room.mjs `roomRowItem`) produced for the same conversation. `mergeToolRows(rowOf(item))`
// must equal them field for field, so the renderer, TUI and phone need no change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { mergeToolRows, rowOf } from '../src/rows.ts';

const golden = JSON.parse(readFileSync(new URL('rows-golden.json', import.meta.url), 'utf8')) as { cases: { name: string; items: Obj[]; rows: Obj[] }[] };
const project = (items: Obj[]): Obj[] => mergeToolRows(items.map(rowOf).filter((row): row is Obj => row !== null));

for (const c of golden.cases) {
  test(`rows equal the Node product's: ${c.name}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(project(c.items))), c.rows);
  });
}

test('a tool call still running is its own card, never part of an aggregate; reasoning has no row', () => {
  const call = (id: string, status: string, output?: string): Obj => ({ type: 'toolCall', id, name: 'read', input: { path: id }, ...(output === undefined ? {} : { output }), meta: { status, at: 1 } });
  const rows = project([
    call('a', 'completed', 'one'),
    call('b', 'completed', 'two'),
    call('c', 'inProgress'),
    { type: 'reasoning', id: 'r', summary: ['x'], content: [], meta: {} },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.name]), [['a', '__aggregate__'], ['c', 'read']]);
  assert.equal(rows[1]?.completedCount, 0);
  assert.equal('result' in (rows[1] ?? {}), false);
});

test('rows carry the product row model only: no protocol member names, compaction keeps status and label', () => {
  const rows = project([
    { type: 'toolCall', id: 'x', name: 'shell', input: { command: 'ls' }, output: '[exit code: 0]\nfile', meta: { status: 'completed' } },
    { type: 'contextCompaction', id: 'k', summary: 'long text', meta: { status: 'completed', at: 9 } },
    { type: 'agentMessage', id: 'm', text: 'hi', meta: { status: 'completed' } },
  ]);
  for (const row of rows) for (const leaked of ['type', 'meta', 'exitCode', 'durationMs', 'output', 'summary']) assert.equal(leaked in row, false, `${leaked} on ${row.id}`);
  assert.deepEqual(rows[1], { kind: 'statusdone', id: 'k', status: 'compacted', label: 'Conversation compacted', at: 9 });
  assert.equal('status' in (rows[2] ?? {}), false);
});

