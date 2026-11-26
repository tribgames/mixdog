// The live turn's transcript, replayed from the notifications the Rust core sent for the real-turn harness's `edit` scenario (a read, an
// edit and a reply), as recorded and untouched (`live-turn-items.json`: every notification the client received, in order).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

const read = (name: string): any => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const frames = read('live-turn-items.json') as { method: string; params: Obj }[];

function rowsOf(notifications: { method: string; params: Obj }[]): Obj[] {
  let fold = sessionReducer.initial({ thread: { id: 'thread' }, state: {}, items: [] });
  for (const n of notifications)
    fold = sessionReducer.apply(fold, { jsonrpc: '2.0', method: n.method, params: n.params } as never);
  return desktopSessionState(fold, []).items as Obj[];
}

test('a restored single tool call stays the per-call card; a live one is an aggregate', () => {
  const restored = frames.map((f) => {
    if (!f.params.item) return f;
    const item = JSON.parse(JSON.stringify(f.params.item, (k, v) => (k === 'live' ? undefined : v)));
    return { ...f, params: { ...f.params, item } };
  });
  const names = (rows: Obj[]): unknown[] => rows.filter((r) => r.kind === 'tool').map((r) => r.name);
  assert.deepEqual(names(rowsOf(restored)), ['read', 'edit']);
  assert.deepEqual(names(rowsOf(frames)), ['__aggregate__', '__aggregate__']);
});
