// The rows a positioned fold shows around a turn's end and a compaction are a function of what it holds: the stored
// units in their order, then the rows no record shows yet. Inputs are inline, in the shapes the core's frames carry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import * as state from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';
import { countFoldWork } from '../src/positioned.ts';
import { windowWant } from '../src/transcript-window.ts';

const { sessionReducer, desktopSessionState } = state;

type O = Record<string, any>;

const pos = (id: string) => `h1:0:${id}`;
const ext = (id: string, more: O = {}) => ({ historyPosition: pos(id), ...more });
const prompt = (id: string) => ({ type: 'userMessage', id, content: [{ type: 'text', text: id }], meta: { ext: ext(id) } });
const call = (id: string, more: O = {}) => ({
  type: 'toolCall',
  id,
  name: 'read',
  input: { path: `${id}.rs` },
  run: { callId: id, result: 'ok' },
  meta: { status: 'completed', ext: ext(id, more) },
});
const reply = (id: string) => ({ type: 'agentMessage', id, text: id, meta: { ext: ext(id) } });
const divider = (cid: string, detail?: string) => ({
  type: 'contextCompaction',
  id: `divider:${cid}`,
  meta: { at: 9_000, label: 'Conversation compacted', ...(detail ? { detail } : {}) },
});
const storedEnd = (of: string) => ({
  type: 'turnEnd',
  id: `${of}:2`,
  status: 'done',
  elapsedMs: 1_000,
  finalAssistantId: of,
  meta: { at: 2_000, ext: ext(of, { attemptId: `att-${of}` }) },
});
const unit = (...items: O[]) => ({ position: pos(items[0]!.id), items });
const finished = (of: string) => unit(reply(of), storedEnd(of));
const cont = (position: string) => ({ kind: 'continuation', position });
const end = { kind: 'end' };
const ids = (s: SessionFold) => s.items.map((row) => row.id);
const at = (s: SessionFold, method: string, params: O) =>
  sessionReducer.apply(s, { method, params: { threadId: 't', ...params } } as never);
const insert = (s: SessionFold, after: string, u: O) =>
  at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'insert', after: pos(after), unit: u } });
const replace = (s: SessionFold, u: O) => at(s, 'thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: u } });
const windowed = (s: SessionFold, version: number, ranges: O[], added: O[], removed: string[] = []) =>
  at(s, 'thread/window/changed', {
    subscriptionId: 'sub',
    requestId: `q${version}`,
    windowVersion: version,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: version },
    ranges,
    removed,
    added,
    followTail: true,
  });
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

test("a divider's figures are its record's: a later read of the record keeps them, as a fresh snapshot shows them", () => {
  const figures = '70s · 499k→67k';
  let s = snapshot([unit(prompt('u1')), unit(call('c1'))]);
  // The compaction's record is read again with the divider, then again once the pass's figures are known.
  s = replace(s, unit(call('c1', { archived: true, dividersAfter: [divider('k1')] })));
  s = replace(s, unit(call('c1', { archived: true, dividersAfter: [divider('k1', figures)] })));
  assert.equal(s.items.at(-1)?.detail, figures);
  // A second compaction reads the held records again.
  s = insert(s, 'c1', unit(call('c2')));
  s = replace(s, unit(call('c1', { archived: true, dividersAfter: [divider('k1', figures)] })));
  s = replace(s, unit(call('c2', { archived: true, dividersAfter: [divider('k2')] })));
  assert.deepEqual(ids(s), ['u1', 'c1', 'divider:k1', 'c2', 'divider:k2']);
  assert.equal(s.items[2]?.detail, figures, 'the figures stay');
  const fresh = snapshot([
    unit(prompt('u1')),
    unit(call('c1', { archived: true, dividersAfter: [divider('k1', figures)] })),
    unit(call('c2', { archived: true, dividersAfter: [divider('k2')] })),
  ]);
  assert.deepEqual(
    s.items.map((row) => [row.id, row.detail]),
    fresh.items.map((row) => [row.id, row.detail])
  );
});

test("a history range apart from the tail shows the divider with its figures, as the tail's run did", () => {
  const figures = '70s · 499k→67k';
  const carrier = unit(call('c2', { dividersAfter: [divider('k1', figures)] }));
  // Opened below the divider: no row of it.
  let s = snapshot([unit(call('c3')), unit(call('c4'))], [], 'c3');
  assert.deepEqual(ids(s), ['c3', 'c4']);
  // Paged up until the carrier's range joins the tail.
  s = windowed(
    s,
    11,
    [
      { id: 'tail', older: cont(pos('c3')), newer: end },
      { id: 'q:q11:0', older: cont(pos('c1')), newer: cont(pos('c3')) },
    ],
    [{ range: 'q:q11:0', units: [unit(call('c1')), carrier, unit(call('c3'))] }]
  );
  assert.deepEqual(
    s.items.map((row) => [row.id, row.detail]),
    [['c1', undefined], ['c2', undefined], ['divider:k1', figures], ['c3', undefined], ['c4', undefined]]
  );
  // Scrolled farther: the range that connected it to the tail is released, the carrier stays in a range apart.
  s = windowed(
    s,
    12,
    [
      { id: 'tail', older: cont(pos('c3')), newer: end },
      { id: 'q:q12:0', older: end, newer: cont(pos('c2')) },
    ],
    [{ range: 'q:q12:0', units: [unit(prompt('u1')), unit(call('c1')), carrier] }],
    ['q:q11:0']
  );
  assert.deepEqual(ids(s), ['c3', 'c4']);
  const view = desktopSessionState(s, []).transcriptViewItems as O[];
  const shown = view.find((row) => row.id === 'divider:k1');
  assert.equal(shown?.detail, figures, 'the range read apart shows the same divider');
});

test('a frame at the tail places what it changed: the rows laid out do not grow with the rows held', () => {
  /** What a turn's last frames cost on a window of `records` records: rows laid out, and entries copied or walked. */
  const cost = (records: number): { placed: number[]; copied: number[]; merged: number[] } => {
    const units: O[] = [];
    for (let n = 0; n < records; n += 1) units.push(n % 4 === 0 ? unit(reply(`a${n}`)) : unit(call(`t${n}`)));
    let s = snapshot(units);
    desktopSessionState(s, []);
    const last = units.at(-1)!.items[0].id as string;
    const spent = { placed: [] as number[], copied: [] as number[], merged: [] as number[] };
    const frame = (next: () => SessionFold) => {
      const work = { placed: 0, copied: 0, merged: 0 };
      countFoldWork(work);
      s = next();
      desktopSessionState(s, []);
      countFoldWork(null);
      spent.placed.push(work.placed);
      spent.copied.push(work.copied);
      spent.merged.push(work.merged);
    };
    // The running turn: a call in progress, a record stored at the tail, that record read again, the turn's end.
    frame(() => at(s, 'item/started', { turnId: 'turn', item: { type: 'toolCall', id: 'live', name: 'read', input: {}, meta: {} } }));
    frame(() => insert(s, last, unit(call('live'))));
    frame(() => replace(s, unit(call('live', { archived: true }))));
    frame(() => insert(s, 'live', finished('fin')));
    frame(() => at(s, 'item/started', { turnId: 'next', item: { type: 'toolCall', id: 'more', name: 'read', input: {}, meta: {} } }));
    assert.deepEqual(ids(s).slice(-4), ['live', 'fin', 'fin:2', 'more']);
    assert.equal(s.items.length, records + 4);
    // A record far from the end read again (a compaction reads every one): the same rows, told anew.
    frame(() => replace(s, unit(call('t50', { archived: true }))));
    frame(() => replace(s, unit(reply('a48'))));
    return spent;
  };
  const small = cost(100);
  const large = cost(1_600);
  assert.deepEqual(large.placed, small.placed);
  assert.ok(small.placed.every((rows) => rows > 0 && rows < 16), `${small.placed}`);
  // The merge reads the rows that changed and those up to the marks around them, wherever in the window they are: a
  // record read again in the middle costs what one at the end does, at any size.
  assert.deepEqual(large.merged, small.merged);
  assert.ok(small.merged.every((rows) => rows < 16), `${small.merged}`);
  // What stays linear in the rows held are whole-array copies (the row list, the merged list, the tail's positions on
  // an insert, the id index when first read): counted, at most four of them a frame, and two for a record read again.
  assert.ok(large.copied.every((entries) => entries <= 4 * 1_606 + 128), `${large.copied}`);
  assert.ok(small.copied.every((entries) => entries <= 4 * 106 + 128), `${small.copied}`);
  assert.ok(large.copied.slice(-2).every((entries) => entries <= 2 * 1_606 + 128), `${large.copied.slice(-2)}`);
});

test('the time of a frame at a full window with two readers: one arriving record, and a compaction of the whole window', (t) => {
  // The tail reaches its bound with the two hundred records that arrive: a window past it would be read anew.
  const TAIL = 1_848;
  const APART = 2_048;
  const tail: O[] = [];
  const apart: O[] = [];
  for (let n = 0; n < TAIL; n += 1) tail.push({ ...unit(n % 4 === 0 ? reply(`a${n}`) : call(`t${n}`)), ordinal: 100_000 + n });
  for (let n = 0; n < APART; n += 1) apart.push({ ...unit(n % 4 === 0 ? reply(`b${n}`) : call(`s${n}`)), ordinal: n });
  let s = snapshot(tail, [], tail[0]!.items[0].id);
  s = windowed(
    s,
    11,
    [
      { id: 'tail', older: cont(tail[0]!.position), newer: end },
      { id: 'q:apart', older: cont(apart[0]!.position), newer: cont(apart.at(-1)!.position) },
    ],
    [{ range: 'q:apart', units: apart }]
  );
  const readers = [
    { kind: 'read', first: 't1846', last: 't1847', end: true, reader: 'A' },
    { kind: 'read', first: 's1001', last: 's1010', reader: 'B' },
  ] as const;
  const shown = (fold: SessionFold) => {
    desktopSessionState(fold, []);
    for (const reader of readers) windowWant(fold.held!, reader, readers.filter((other) => other !== reader));
    windowWant(fold.held!, { kind: 'keep' }, readers);
  };
  shown(s);
  assert.equal(s.held!.units.size, TAIL + APART);
  // One record arriving at the tail, as its frame costs: folded, projected, and each reader's want decided.
  const arrivals: number[] = [];
  for (let n = 0; n < 200; n += 1) {
    const began = performance.now();
    s = at(s, 'thread/transcript/changed', {
      lineage: 1,
      change: { op: 'insert', unit: { ...unit(call(`n${n}`)), ordinal: 200_000 + n } },
    });
    shown(s);
    arrivals.push(performance.now() - began);
  }
  arrivals.sort((x, y) => x - y);
  const median = arrivals[100]!;
  const worst = arrivals.at(-1)!;
  // A compaction reads every held record again: one frame per record, each folded and projected.
  const began = performance.now();
  let slowest = 0;
  const held = [...s.held!.units.keys()].length;
  assert.equal(held, TAIL + APART + 200);
  const all = [...apart, ...tail];
  for (const told of all) {
    const one = performance.now();
    const [item] = told.items;
    s = replace(s, { ...told, items: [{ ...item, meta: { ...item.meta, ext: { ...item.meta.ext, archived: true } } }] });
    shown(s);
    slowest = Math.max(slowest, performance.now() - one);
  }
  const whole = performance.now() - began;
  t.diagnostic(
    `${held} records held, two readers: one arriving record ${median.toFixed(2)} ms (median), ${worst.toFixed(2)} ms (worst of 200); ` +
      `a compaction of the whole window ${whole.toFixed(0)} ms in all over ${all.length} frames, ${(whole / all.length).toFixed(2)} ms a frame, ${slowest.toFixed(2)} ms the slowest`
  );
  assert.ok(median < 16, `one arriving record: ${median} ms`);
  assert.ok(whole / all.length < 16, `a compaction frame: ${whole / all.length} ms`);
});
