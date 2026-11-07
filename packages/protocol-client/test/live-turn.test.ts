// The live turn's transcript, replayed from a recorded Rust turn against the Node product's own rows. `live-turn-items.json` is the
// item notifications the Rust core sent for the real-turn harness's `edit` scenario (a read, an edit and a reply), with the live-form
// carriers the core now puts on its live items (`live_form`: `run.live` on a tool call; `attemptId`, `completionVerb` and
// `streaming: false` on an assistant row; no `checkpointId` on the input row). `live-turn-rows.node.json` is what the Node daemon's
// session held for the same turn, ids and times normalized (ids by first appearance, as the harness does).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

const read = (name: string): any => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const frames = read('live-turn-items.json') as { method: string; params: Obj }[];
const node = read('live-turn-rows.node.json') as Obj[];

const OPAQUE_ID = /\b(?:itm_|msg_)[0-9a-f]{32}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function normalize(value: unknown): unknown {
  const seen = new Map<string, number>();
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') return v.replace(OPAQUE_ID, (raw) => `<id:${seen.get(raw) ?? seen.set(raw, seen.size + 1).get(raw)}>`);
    if (typeof v === 'number') return /(^at$|At$|Ms$)/.test(key) ? '<ts>' : v;
    if (Array.isArray(v)) return v.map((e) => walk(e, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk((v as Obj)[k], k)]));
    return v;
  };
  return walk(value);
}

// The diff the edit tool's result carries comes from the turn review (`patch_review`), which the harness run does not enable.
const withoutUiDiff = (rows: Obj[]): Obj[] =>
  JSON.parse(JSON.stringify(rows, (k, v) => (k === 'uiDiff' ? undefined : v)));

function rowsOf(notifications: { method: string; params: Obj }[]): Obj[] {
  let fold = sessionReducer.initial({ thread: { id: 'thread' }, state: {}, items: [] });
  for (const n of notifications) fold = sessionReducer.apply(fold, { jsonrpc: '2.0', method: n.method, params: n.params } as never);
  return desktopSessionState(fold, []).items as Obj[];
}

test("a live turn's rows equal the Node daemon's: aggregates for single calls, live stamps on assistant rows", () => {
  const rows = rowsOf(frames);
  assert.deepEqual(normalize(withoutUiDiff(JSON.parse(JSON.stringify(rows)))), normalize(withoutUiDiff(node)));
});

test('a restored single tool call stays the per-call card; a live one is an aggregate', () => {
  const restored = frames.map((f) => ({ ...f, params: { item: JSON.parse(JSON.stringify(f.params.item, (k, v) => (k === 'live' ? undefined : v))) } }));
  const names = (rows: Obj[]): unknown[] => rows.filter((r) => r.kind === 'tool').map((r) => r.name);
  assert.deepEqual(names(rowsOf(restored)), ['read', 'edit']);
  assert.deepEqual(names(rowsOf(frames)), ['__aggregate__', '__aggregate__']);
});
