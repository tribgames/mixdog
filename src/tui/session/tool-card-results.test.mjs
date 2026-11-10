import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolCardResults } from './tool-card-results.mjs';

function harness({ buildAgentJobCardPatch } = {}) {
  const items = [];
  const itemIndexById = new Map();
  const state = { items };
  const markedDone = [];
  const sets = [];
  const addItem = (item) => {
    itemIndexById.set(item.id, items.length);
    items.push(item);
    return item;
  };
  const patchItem = (id, patch) => {
    const index = itemIndexById.get(id);
    if (!Number.isInteger(index)) return false;
    items[index] = { ...items[index], ...patch };
    return true;
  };
  const api = createToolCardResults({
    getState: () => state,
    set: (patch) => sets.push(patch),
    patchItem,
    markToolCallDone: (id) => markedDone.push(id),
    buildAgentJobCardPatch: buildAgentJobCardPatch || (() => ({})),
    agentStatusState: ({ force }) => ({ agentStatus: { force } }),
    itemIndexById,
  });
  const itemOf = (id) => items[itemIndexById.get(id)];
  return { api, addItem, itemOf, markedDone, sets };
}

function aggregateCall(callId, name, args, category) {
  return {
    callId,
    name,
    args,
    category,
    summary: null,
    summarySeq: null,
    isError: false,
    isCallError: false,
    isExitError: false,
    exitCode: null,
    resultText: null,
    rawResultText: null,
    resolved: false,
    completedEarly: false,
    startedAt: 1000,
    completedAt: null,
  };
}

function aggregateFixture(h) {
  const item = h.addItem({ id: 'agg-1', kind: 'tool', aggregate: true, count: 2, completedCount: 0 });
  const visible = [];
  const aggregate = {
    itemId: item.id,
    calls: new Map([
      ['c1', aggregateCall('c1', 'read', { file_path: 'a.mjs' }, 'Read')],
      ['c2', aggregateCall('c2', 'grep', { pattern: 'foo' }, 'Search')],
    ]),
    ensureVisible: () => visible.push('agg'),
  };
  const cards = [
    { itemId: item.id, callId: 'c1', aggregate, done: false },
    { itemId: item.id, callId: 'c2', aggregate, done: false },
  ];
  return { item, aggregate, cards, visible, cardByCallId: new Map(cards.map((c) => [c.callId, c])) };
}

const toolMessage = (callId, content, extra = {}) => ({ role: 'tool', tool_call_id: callId, content, ...extra });

test('aggregate card: each resolving call advances the visible count and rolls up the raw result', () => {
  const h = harness();
  const f = aggregateFixture(h);
  const done = new Set();
  assert.equal(h.api.patchToolCardResult(f.cards[0], toolMessage('c1', '1→line'), new Map(), done), true);
  assert.deepEqual(h.markedDone, ['c1']);
  assert.deepEqual(f.visible, ['agg']);
  let item = h.itemOf('agg-1');
  assert.equal(item.completedCount, 1);
  assert.equal(item.count, 2);
  assert.equal(item.isError, false);
  assert.match(item.rawResult, /^1\. read\n1→line$/);
  assert.equal(item.toolMembers.length, 2);
  assert.equal(Object.keys(item.doneCategories).length, 2);
  assert.ok(item.completedAt > 0);
  assert.equal(f.cards[0].done, true);
  assert.ok(done.has('c1'));

  assert.equal(
    h.api.patchToolCardResult(f.cards[1], toolMessage('c2', 'a.mjs:1:foo', { uiDiff: 'd' }), new Map(), done),
    true
  );
  item = h.itemOf('agg-1');
  assert.equal(item.completedCount, 2);
  assert.equal(item.uiDiff, 'd');
  assert.match(item.rawResult, /1\. read\n1→line\n\n2\. grep\na\.mjs:1:foo$/);
});

test('aggregate card: a repeated result for an already-resolved call is ignored but closes the card', () => {
  const h = harness();
  const f = aggregateFixture(h);
  const done = new Set();
  f.aggregate.calls.get('c1').resolved = true;
  assert.equal(h.api.patchToolCardResult(f.cards[0], toolMessage('c1', 'again'), new Map(), done), false);
  assert.equal(f.cards[0].done, true);
  assert.ok(done.has('c1'));
  assert.equal(h.itemOf('agg-1').completedCount, 0);
});

test('non-aggregate card: an empty failed body is stamped with a non-empty fallback, even after the agent patch', () => {
  const h = harness({ buildAgentJobCardPatch: () => ({ result: '', text: '' }) });
  h.addItem({ id: 'card-1', kind: 'tool', name: 'shell', count: 1, completedCount: 0 });
  const card = { itemId: 'card-1', callId: 'c1', done: false, ensureVisible: () => {} };
  const groups = new Map();
  const done = new Set();
  assert.equal(h.api.patchToolCardResult(card, toolMessage('c1', '', { isError: true }), groups, done), true);
  const item = h.itemOf('card-1');
  // The agent patch blanked the body; the guard restores the error display text.
  assert.equal(item.result, 'Error: Unknown error');
  assert.equal(item.text, 'Error: Unknown error');
  assert.equal(item.isError, true);
  assert.equal(item.errorCount, 1);
  assert.equal(item.callErrorCount, 1);
  assert.equal(item.completedCount, 1);
  assert.equal(item.liveOutput, null);
  assert.equal(groups.get('card-1').errors, 1);
});

test('non-aggregate card: an agent envelope result refreshes agent status and keeps the raw result for expand', () => {
  const h = harness();
  h.addItem({ id: 'card-1', kind: 'tool', name: 'agent', count: 1, completedCount: 0 });
  const card = { itemId: 'card-1', callId: 'c1', done: false };
  const raw = 'agent task: t-1\nstatus: running\nagent: worker';
  assert.equal(h.api.patchToolCardResult(card, toolMessage('c1', raw), new Map(), new Set()), true);
  assert.deepEqual(h.sets, [{ agentStatus: { force: true } }]);
  const item = h.itemOf('card-1');
  assert.equal(item.rawResult, raw);
  assert.equal(item.result, raw);
  assert.equal(item.isError, false);
});

test('flushToolResults: an id-less result falls back to the oldest open card', () => {
  const h = harness();
  h.addItem({ id: 'card-1', kind: 'tool', name: 'read', count: 1, completedCount: 0 });
  const card = { itemId: 'card-1', callId: 'c9', done: false };
  const done = new Set();
  h.api.flushToolResults([{ role: 'tool', content: 'orphan output' }], [card], new Map(), new Map(), done);
  assert.equal(card.done, true);
  assert.equal(h.itemOf('card-1').result, 'orphan output');
  assert.ok(done.has('c9'));
});

test('flushToolResults finalize: unresolved aggregate calls are stamped done and a cancelled turn keeps the marker', () => {
  const h = harness();
  const f = aggregateFixture(h);
  const done = new Set();
  // First call completed early with a real result; second never came back.
  Object.assign(f.aggregate.calls.get('c1'), { completedEarly: true, isError: true, resultText: 'boom' });
  h.api.flushToolResults([], f.cards, f.cardByCallId, new Map(), done, { finalize: true, cancelled: true });
  const item = h.itemOf('agg-1');
  assert.equal(item.completedCount, 2);
  assert.equal(item.errorCount, 1);
  assert.equal(f.aggregate.calls.get('c1').isError, true, 'early record keeps its real outcome');
  assert.equal(f.aggregate.calls.get('c2').isError, false);
  assert.equal(f.aggregate.calls.get('c2').resultText, '');
  assert.match(item.result, /^\[status: cancelled\]\n/);
  assert.ok(f.cards.every((c) => c.done));
  assert.deepEqual([...done].sort(), ['c1', 'c2']);
  assert.deepEqual(f.visible, ['agg']);
});

test('flushToolResults finalize: an open non-aggregate card settles with its exit fallback and cancelled marker', () => {
  const h = harness();
  h.addItem({ id: 'card-1', kind: 'tool', name: 'shell', count: 2, completedCount: 1 });
  const card = { itemId: 'card-1', callId: 'c1', done: false };
  const groups = new Map([
    [
      'card-1',
      {
        count: 2,
        completed: 1,
        errors: 1,
        callErrors: 0,
        exitErrors: 1,
        results: [{ text: '', isError: true, isExitError: true, exitCode: 3 }],
      },
    ],
  ]);
  const done = new Set();
  h.api.flushToolResults([], [card], new Map(), groups, done, { finalize: true, cancelled: true });
  const item = h.itemOf('card-1');
  assert.equal(item.completedCount, 2);
  assert.equal(item.isError, true);
  assert.equal(item.exitErrorCount, 1);
  assert.equal(item.result, '[status: cancelled]\n1 Failed · 1 Exited non-zero');
  assert.equal(item.liveOutput, null);
  assert.equal(card.done, true);
  assert.ok(done.has('c1'));

  // Without a cancel, a bare exit-only single card reports the exit code.
  const h2 = harness();
  h2.addItem({ id: 'card-2', kind: 'tool', name: 'shell', count: 1, completedCount: 0 });
  const card2 = { itemId: 'card-2', callId: 'c2', done: false };
  const groups2 = new Map([
    [
      'card-2',
      {
        count: 1,
        completed: 0,
        errors: 1,
        exitErrors: 1,
        results: [{ text: '', isError: true, isExitError: true, exitCode: 3 }],
      },
    ],
  ]);
  h2.api.flushToolResults([], [card2], new Map(), groups2, new Set(), { finalize: true });
  assert.equal(h2.itemOf('card-2').result, 'Exited 3');
});
