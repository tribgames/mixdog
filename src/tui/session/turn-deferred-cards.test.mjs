import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeferredCardRegistry } from './turn-deferred-cards.mjs';
import { collectClosingCards, createTurnToolCards } from './turn-tool-cards.mjs';

function fixture(t, { createRegistry = createDeferredCardRegistry, batchAppend = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { items: [], structureRevision: 0 };
  const flags = { pushingFromDeferredEntry: false };
  const itemIndexById = new Map();
  const commits = [];
  let current = true;
  const set = (patch) => {
    commits.push({ patch, deferred: flags.pushingFromDeferredEntry });
    Object.assign(state, patch);
  };
  const appendItems = (items, extra) => {
    const next = [...state.items, ...items];
    next.forEach((item, index) => {
      itemIndexById.set(item.id, index);
    });
    set({ items: next, structureRevision: state.structureRevision + 1, ...extra });
  };
  const registry = createRegistry({
    isCurrentTurn: () => current,
    flags,
    pushItem: () => assert.fail('deferred cards must commit as a batch'),
    ...(batchAppend ? { appendItems } : {}),
    getState: () => state,
    set,
    itemIndexById,
  });
  t.after(() => registry.clearTimers());
  return { registry, state, flags, itemIndexById, commits, makeStale: () => (current = false) };
}

test('a later card surfaces preceding standalone and aggregate specs once in creation order', (t) => {
  const h = fixture(t);
  const card = { pushed: false, spec: { kind: 'tool', id: 'first' } };
  const aggregate = { pushed: false, pendingSpec: { kind: 'tool', id: 'aggregate', count: 2 } };
  h.registry.registerCard(card);
  h.registry.registerAggregate(aggregate);

  aggregate.ensureVisible();
  assert.deepEqual(
    h.state.items.map((item) => item.id),
    ['first', 'aggregate']
  );
  assert.equal(h.state.items[0], card.spec);
  assert.equal(h.state.items[1], aggregate.pendingSpec);
  assert.equal(card.pushed, true);
  assert.equal(aggregate.pushed, true);
  assert.equal(card.spec.deferredDisplayReady, true);
  assert.equal(aggregate.pendingSpec.deferredDisplayReady, true);
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].deferred, true);
  assert.equal(h.flags.pushingFromDeferredEntry, false);

  h.registry.flushAll();
  t.mock.timers.tick(0);
  assert.equal(h.commits.length, 1);
});

test('turn-close collection uses the latest aggregate spec and emits only with the trailing done row', (t) => {
  const h = fixture(t);
  const aggregate = { pushed: false, pendingSpec: { kind: 'tool', id: 'aggregate', count: 1 } };
  h.registry.registerAggregate(aggregate);
  aggregate.pendingSpec = { kind: 'tool', id: 'aggregate', count: 3, completedCount: 3 };

  const closing = collectClosingCards({ deferredCards: h.registry }, false);
  assert.equal(closing.length, 1);
  assert.equal(closing[0], aggregate.pendingSpec);
  assert.equal(closing[0].completedCount, 3);
  assert.equal(closing[0].deferredDisplayReady, true);
  assert.deepEqual(h.commits, []);
  assert.deepEqual(h.registry.collectAll(), []);
  h.registry.appendItemsBatch([...closing, { kind: 'turndone', id: 'done' }], { busy: false });
  assert.deepEqual(
    h.state.items.map((item) => item.id),
    ['aggregate', 'done']
  );
  assert.equal(h.state.busy, false);
  t.mock.timers.tick(0);
  assert.equal(h.commits.length, 1);
});

test('a stale turn neither surfaces cards nor leaves a closing timer that can publish them', (t) => {
  const h = fixture(t);
  const card = { pushed: false, spec: { kind: 'tool', id: 'stale' } };
  h.registry.registerCard(card);
  h.makeStale();
  card.ensureVisible();
  assert.deepEqual(collectClosingCards({ deferredCards: h.registry }, true), []);
  t.mock.timers.tick(0);
  assert.deepEqual(h.state.items, []);
  assert.deepEqual(h.commits, []);
  assert.equal(card.pushed, false);
});

test('the turn-card factory retains fallback batch indexing and one revision increment', (t) => {
  const h = fixture(t, {
    createRegistry: (deps) => createTurnToolCards(deps).deferredCards,
    batchAppend: false,
  });
  h.state.items = [{ kind: 'assistant', id: 'existing' }];
  h.state.structureRevision = 4;
  h.itemIndexById.set('existing', 0);
  h.registry.registerCard({ spec: { kind: 'tool', id: 'one' } });
  h.registry.registerCard({ spec: { kind: 'tool', id: 'two' } });
  h.registry.flushAll();
  t.mock.timers.tick(0);
  assert.deepEqual(
    h.state.items.map((item) => item.id),
    ['existing', 'one', 'two']
  );
  assert.deepEqual(
    [...h.itemIndexById],
    [
      ['existing', 0],
      ['one', 1],
      ['two', 2],
    ]
  );
  assert.equal(h.state.structureRevision, 5);
  assert.equal(h.commits.length, 1);
  assert.equal(h.flags.pushingFromDeferredEntry, false);
});
