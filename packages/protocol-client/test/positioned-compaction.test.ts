// Where a positioned fold shows a compaction's divider, live and read again: on the record that carries it, in the
// records' own order. Inputs are inline, in the shapes the core's frames carry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;

const pos = (id: string) => `h1:0:${id}`;
const ext = (id: string, more: O = {}) => ({ historyPosition: pos(id), ...more });
const prompt = (id: string, more: O = {}) => ({
  type: 'userMessage',
  id,
  content: [{ type: 'text', text: id }],
  meta: { ext: ext(id, more) },
});
const call = (id: string, more: O = {}) => ({
  type: 'toolCall',
  id,
  name: 'read',
  input: { path: `${id}.rs` },
  run: { callId: id, result: 'ok' },
  meta: { status: 'completed', ext: ext(id, more) },
});
const divider = (cid: string, detail?: string) => ({
  type: 'contextCompaction',
  id: `divider:${cid}`,
  meta: { at: 9_000, label: 'Conversation compacted', ...(detail ? { detail } : {}) },
});
const unit = (...items: O[]) => ({ position: pos(items[0]!.id), items });
const cont = (position: string) => ({ kind: 'continuation', position });
const end = { kind: 'end' };
const ids = (s: SessionFold) => s.items.map((row) => row.id);
const at = (s: SessionFold, method: string, params: O) =>
  sessionReducer.apply(s, { method, params: { threadId: 't', ...params } } as never);
const replace = (s: SessionFold, u: O) => at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: u } });
const snapshot = (units: O[], loose: O[] = [], older: string | null = null) =>
  sessionReducer.initial({
    thread: { id: 't' },
    state: {},
    items: loose,
    hasOlder: older !== null,
    window: {
      windowVersion: 10,
      lineage: 1,
      ranges: [{ id: 'tail', older: older === null ? end : cont(pos(older)), newer: end }],
      added: [{ range: 'tail', units }],
      followTail: true,
    },
  } as unknown as Json);

test("a divider's figures arrive on the record that carries it, read again once they are known", () => {
  let s = snapshot([unit(prompt('u1')), unit(call('c1'))]);
  // The compaction's records are read again: the divider rides the record it follows, with no figures yet.
  s = replace(s, unit(call('c1', { dividersAfter: [divider('k1')] })));
  assert.deepEqual(ids(s), ['u1', 'c1', 'divider:k1']);
  assert.equal(s.items.at(-1)?.detail, undefined);
  // Then the pass's figures: the record is read again with them.
  s = replace(s, unit(call('c1', { dividersAfter: [divider('k1', '70s · 499k→67k')] })));
  assert.deepEqual(ids(s), ['u1', 'c1', 'divider:k1']);
  assert.equal(s.items.at(-1)?.detail, '70s · 499k→67k');
});

test('a window that starts below the divider shows none until the record it follows is read, and none again past it', () => {
  // The snapshot carries the newest records; the divider rides a record above them, and no row of it is sent apart.
  let s = snapshot([unit(call('c3')), unit(call('c4'))], [], 'c3');
  assert.deepEqual(ids(s), ['c3', 'c4']);
  // Read up across it: the page holds the record with its divider.
  s = at(s, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: 'up',
    windowVersion: 11,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: 11 },
    ranges: [
      { id: 'tail', older: cont(pos('c3')), newer: end },
      { id: 'q:up:0', older: end, newer: cont(pos('c3')) },
    ],
    removed: [],
    added: [{ range: 'q:up:0', units: [unit(prompt('u2')), unit(call('c1')), unit(call('c2', { dividersAfter: [divider('k1')] })), unit(call('c3'))] }],
    followTail: true,
  });
  assert.deepEqual(ids(s), ['u2', 'c1', 'c2', 'divider:k1', 'c3', 'c4'], 'once, after its record');
  // Back down to the tail: the page is let go, and the divider with it.
  s = at(s, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: 'down',
    windowVersion: 12,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: 12 },
    ranges: [{ id: 'tail', older: cont(pos('c3')), newer: end }],
    removed: ['q:up:0'],
    added: [],
    followTail: true,
  });
  assert.deepEqual(ids(s), ['c3', 'c4']);
});

// A compaction's divider as the core tells it live: a unit of its own, at its own ordinal (`divider:{cid}`).
const numbered = (ordinal: number, ...items: O[]) => ({ position: pos(items[0]!.id), ordinal, items });
const told = (s: SessionFold, u: O) => at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'insert', unit: u } });
const failedEnd = (of: string) => ({ type: 'turnEnd', id: `${of}:2`, status: 'failed', elapsedMs: 1_000, meta: { at: 3_000, ext: ext(of) } });

test('a divider is a unit of its own: it stands at its ordinal, between the records stored before and after it', () => {
  let s = snapshot([numbered(10, prompt('u1')), numbered(20, call('c1'))]);
  s = told(s, numbered(30, divider('k1')));
  s = told(s, numbered(40, call('c2')));
  assert.deepEqual(ids(s), ['u1', 'c1', 'divider:k1', 'c2']);
  // Its figures arrive on its own record, read again.
  s = replace(s, numbered(30, divider('k1', '70s · 499k→67k')));
  assert.deepEqual(ids(s), ['u1', 'c1', 'divider:k1', 'c2']);
  assert.equal(s.items[2]?.detail, '70s · 499k→67k');
});

test('two compactions in a row stand in their order, whichever divider is told first', () => {
  const base = () => snapshot([numbered(10, prompt('u1')), numbered(20, call('c1'))]);
  const inOrder = told(told(base(), numbered(30, divider('k1'))), numbered(31, divider('k2')));
  const reversed = told(told(base(), numbered(31, divider('k2'))), numbered(30, divider('k1')));
  assert.deepEqual(ids(inOrder), ['u1', 'c1', 'divider:k1', 'divider:k2']);
  assert.deepEqual(ids(reversed), ids(inOrder));
});

test('a turn that fails after a compaction ran in it ends below the divider, in either order of arrival', () => {
  // The failed turn's settled text is a record, and its end rides that record.
  const failure = numbered(40, { type: 'agentMessage', id: 'f1', text: 'stopped here', meta: { ext: ext('f1') } }, failedEnd('f1'));
  const base = () => snapshot([numbered(10, prompt('u1')), numbered(20, call('c1'))]);
  const dividerFirst = told(told(base(), numbered(30, divider('k1'))), failure);
  const failureFirst = told(told(base(), failure), numbered(30, divider('k1')));
  assert.deepEqual(ids(dividerFirst), ['u1', 'c1', 'divider:k1', 'f1', 'f1:2']);
  assert.deepEqual(ids(failureFirst), ids(dividerFirst));
});
