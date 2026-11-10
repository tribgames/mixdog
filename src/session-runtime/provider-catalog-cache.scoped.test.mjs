import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import {
  invalidateSharedProviderCatalog,
  scopedProviderCatalog,
  sharedProviderCatalog,
} from './provider-catalog-cache.mjs';

// The process-wide catalog after a provider-scoped refresh: the refreshed
// providers' entries replace their own in the shared state, every other
// provider keeps its entry, and full loads and scoped refreshes publish one at
// a time, so the last write is the newest successful answer.

function provider(models) {
  const self = {
    models,
    calls: 0,
    gate: null,
    failing: false,
    async listModels() {
      self.calls += 1;
      const asked = self.models;
      if (self.failing) throw new Error('down');
      if (self.gate) await self.gate.promise;
      return asked;
    },
  };
  return self;
}

const registryOf = (providers) => ({
  providerCatalogRevision: () => 1,
  getAllProviders: () => new Map(Object.entries(providers)),
});
const ids = (entry) => entry.models.map((model) => model.id);
const entryOf = (entries, name) => entries.find((entry) => entry.name === name);

test('a shared read after a scoped refresh sees the new rows and keeps the other providers', async () => {
  invalidateSharedProviderCatalog();
  const a = provider([{ id: 'old' }]);
  const b = provider([{ id: 'b1' }]);
  const registry = registryOf({ a, b });
  const first = await sharedProviderCatalog(registry);

  a.models = [{ id: 'new' }];
  assert.deepEqual((await scopedProviderCatalog(registry, ['a'])).map(ids), [['new']]);
  const shared = await sharedProviderCatalog(registry);
  assert.deepEqual(ids(entryOf(shared, 'a')), ['new']);
  assert.equal(entryOf(shared, 'b'), entryOf(first, 'b'), 'an untouched provider keeps its entry');
  assert.deepEqual([a.calls, b.calls], [2, 1], 'the shared read came from the merged state');
});

test('a scoped refresh replaces a multi-account provider entry as one, without duplicates or stale accounts', async () => {
  invalidateSharedProviderCatalog();
  const pool = provider([
    { id: 'm1', accountId: 'acct-1' },
    { id: 'm2', accountId: 'acct-2' },
  ]);
  const registry = registryOf({ pool, other: provider([{ id: 'o1' }]) });
  await sharedProviderCatalog(registry);

  pool.models = [
    { id: 'm1', accountId: 'acct-1' },
    { id: 'm3', accountId: 'acct-3' },
  ];
  await scopedProviderCatalog(registry, ['pool']);
  const shared = await sharedProviderCatalog(registry);
  assert.deepEqual(
    shared.map((entry) => entry.name),
    ['pool', 'other']
  );
  assert.deepEqual(
    entryOf(shared, 'pool').models.map((model) => `${model.accountId}/${model.id}`),
    ['acct-1/m1', 'acct-3/m3']
  );
});

test('a scoped refresh that answers the missing provider of a partial catalog completes it', async () => {
  invalidateSharedProviderCatalog();
  const a = provider([{ id: 'a1' }]);
  const b = provider([{ id: 'b1' }]);
  b.failing = true;
  const registry = registryOf({ a, b });
  assert.equal(Object.hasOwn(entryOf(await sharedProviderCatalog(registry), 'b'), 'error'), true);

  b.failing = false;
  await scopedProviderCatalog(registry, ['b']);
  assert.deepEqual((await sharedProviderCatalog(registry)).map(ids), [['a1'], ['b1']]);
  assert.equal(a.calls, 1, 'the whole catalog was not asked again');
});

test('a failed scoped read replaces nothing', async () => {
  invalidateSharedProviderCatalog();
  const a = provider([{ id: 'a1' }]);
  const registry = registryOf({ a });
  await sharedProviderCatalog(registry);
  a.failing = true;
  const [failed] = await scopedProviderCatalog(registry, ['a']);
  assert.equal(Object.hasOwn(failed, 'error'), true);
  assert.deepEqual(ids(entryOf(await sharedProviderCatalog(registry), 'a')), ['a1']);
});

test('a superseded scoped result does not come back after a later failure', async () => {
  invalidateSharedProviderCatalog();
  const a = provider([{ id: 'old' }]);
  const registry = registryOf({ a });
  await sharedProviderCatalog(registry);

  a.models = [{ id: 'new' }];
  await scopedProviderCatalog(registry, ['a']);
  a.models = [{ id: 'newest' }];
  assert.deepEqual((await sharedProviderCatalog(registry, { force: true })).map(ids), [['newest']]);

  a.failing = true;
  const failed = await sharedProviderCatalog(registry, { force: true });
  assert.equal(Object.hasOwn(failed[0], 'error'), true, 'the failure is reported, not hidden behind an old answer');
  assert.deepEqual(failed[0].models, []);
});

test('a scoped refresh and a full load that overlap publish one at a time, newest last', async () => {
  invalidateSharedProviderCatalog();
  const a = provider([{ id: 'old' }]);
  const b = provider([{ id: 'b1' }]);
  const registry = registryOf({ a, b });

  // A full load is in flight (b is slow) when a scoped refresh of `a` starts.
  b.gate = Promise.withResolvers();
  const full = sharedProviderCatalog(registry, { force: true });
  await setImmediate();
  a.models = [{ id: 'new' }];
  const scoped = scopedProviderCatalog(registry, ['a']);
  b.gate.resolve();
  await Promise.all([full, scoped]);
  assert.deepEqual(ids(entryOf(await sharedProviderCatalog(registry), 'a')), ['new']);

  // A scoped refresh is in flight (a is slow) when a full load starts.
  a.gate = Promise.withResolvers();
  a.models = [{ id: 'newer' }];
  const slowScoped = scopedProviderCatalog(registry, ['a']);
  await setImmediate();
  a.models = [{ id: 'newest' }];
  const laterFull = sharedProviderCatalog(registry, { force: true });
  a.gate.resolve();
  await Promise.all([slowScoped, laterFull]);
  assert.deepEqual(ids(entryOf(await sharedProviderCatalog(registry), 'a')), ['newest']);
});
