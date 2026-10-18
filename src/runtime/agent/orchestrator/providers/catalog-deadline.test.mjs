import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import {
  invalidateSharedProviderCatalog,
  sharedProviderCatalog,
} from '../../../../session-runtime/provider-catalog-cache.mjs';
import {
  boundedProviderCatalogOp,
  bumpProviderCatalogGeneration,
  pendingProviderCatalogOps,
  stalledProviderCatalogOps,
} from './catalog-deadline.mjs';

/** A list that ignores its abort signal and settles only when told to. */
function stubbornList() {
  const calls = [];
  const run = (signal) => {
    const { promise, resolve } = Promise.withResolvers();
    calls.push({ signal, resolve });
    return promise;
  };
  return { calls, run };
}

const list = (name, provider, run, extra = {}) =>
  boundedProviderCatalogOp({ name, provider, kind: 'list', run, timeoutMs: 20, ...extra });

test('a list that ignores its abort is not invoked again, across generations and epochs, until it settles', async () => {
  const provider = {};
  const stubborn = stubbornList();
  const first = await list('stubborn-a', provider, stubborn.run, { epoch: 'r1' });
  assert.equal(first.timedOut, true);
  assert.equal(stubborn.calls[0].signal.aborted, true, 'the deadline still aborts it');
  assert.deepEqual(stalledProviderCatalogOps(), [{ name: 'stubborn-a', kind: 'list' }]);

  // An account change and a new catalog revision would each have started a
  // fresh list beside the stuck one.
  bumpProviderCatalogGeneration();
  const startedAt = performance.now();
  const second = await list('stubborn-a', provider, stubborn.run, { epoch: 'r2' });
  assert.equal(second.timedOut, true);
  assert.equal(second.stalled, true);
  assert.equal(second.error.code, 'ETIMEDOUT');
  assert.ok(performance.now() - startedAt < 15, 'answered at once, without a deadline wait');
  assert.equal(stubborn.calls.length, 1);
  assert.equal(pendingProviderCatalogOps().filter((name) => name === 'stubborn-a').length, 1);

  // Once it settles the flag clears and the provider is asked again.
  stubborn.calls[0].resolve(['late']);
  await setImmediate();
  assert.deepEqual(stalledProviderCatalogOps(), []);
  assert.equal(pendingProviderCatalogOps().includes('stubborn-a'), false);
  const run = (signal) => {
    stubborn.calls.push({ signal });
    return ['fresh'];
  };
  assert.deepEqual(await list('stubborn-a', provider, run, { epoch: 'r2' }), { value: ['fresh'] });
  assert.equal(stubborn.calls.length, 2);
});

test('a list that honors its abort leaves no stall behind', async () => {
  const provider = {};
  let calls = 0;
  const run = (signal) => {
    calls += 1;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  assert.equal((await list('polite-a', provider, run)).timedOut, true);
  await setImmediate();
  assert.deepEqual(stalledProviderCatalogOps(), []);
  bumpProviderCatalogGeneration();
  assert.equal((await list('polite-a', provider, run)).stalled, undefined);
  assert.equal(calls, 2);
  await setImmediate();
});

test('a rebuilt provider instance of the same name is not asked while the old stalled call runs', async () => {
  const stubborn = stubbornList();
  await list('stubborn-b', {}, stubborn.run);
  const replacement = {};
  let replacementCalls = 0;
  const fresh = () => {
    replacementCalls += 1;
    return ['from-new-instance'];
  };
  const skipped = await list('stubborn-b', replacement, fresh);
  assert.equal(skipped.stalled, true);
  assert.equal(replacementCalls, 0, 'a registry rebuild does not add a call beside the stuck one');
  assert.deepEqual(stalledProviderCatalogOps(), [{ name: 'stubborn-b', kind: 'list' }]);

  stubborn.calls[0].resolve([]);
  await setImmediate();
  assert.deepEqual(stalledProviderCatalogOps(), []);
  assert.deepEqual(await list('stubborn-b', replacement, fresh), { value: ['from-new-instance'] });
  assert.equal(replacementCalls, 1);
});

test('calls superseded inside one deadline window stall together and stop further calls until all settle', async () => {
  const provider = {};
  const stuck = stubbornList();
  // An account change while the first list is still inside its deadline.
  const first = list('slow-c', provider, stuck.run);
  bumpProviderCatalogGeneration();
  const second = list('slow-c', provider, stuck.run, { epoch: 'r2' });
  assert.equal((await first).timedOut, true);
  assert.equal((await second).timedOut, true);
  assert.equal(stuck.calls.length, 2);
  assert.equal(stalledProviderCatalogOps().filter(({ name }) => name === 'slow-c').length, 2);

  for (let round = 0; round < 5; round += 1) {
    bumpProviderCatalogGeneration();
    assert.equal((await list('slow-c', {}, stuck.run, { epoch: `r${round + 3}` })).stalled, true);
  }
  assert.equal(stuck.calls.length, 2, 'no further calls while either one is unsettled');
  stuck.calls[0].resolve([]);
  await setImmediate();
  assert.equal((await list('slow-c', provider, stuck.run, { epoch: 'r9' })).stalled, true);
  stuck.calls[1].resolve([]);
  await setImmediate();
  assert.deepEqual(stalledProviderCatalogOps(), []);
  assert.deepEqual(await list('slow-c', provider, () => ['ok'], { epoch: 'r9' }), { value: ['ok'] });
});

test('shared catalog reloads never stack calls in a provider that ignores cancellation', async () => {
  const healthy = {
    calls: 0,
    async listModels() {
      healthy.calls += 1;
      return [{ id: 'ok-model' }];
    },
  };
  const stubborn = stubbornList();
  const hung = { listModels: ({ signal }) => stubborn.run(signal) };
  let revision = 9_100;
  const registry = {
    providerCatalogRevision: () => revision,
    getAllProviders: () =>
      new Map([
        ['soak-ok', healthy],
        ['soak-hung', hung],
      ]),
  };
  for (let round = 0; round < 12; round += 1) {
    if (round % 3 === 0) invalidateSharedProviderCatalog();
    if (round % 4 === 0) revision += 1;
    const entries = await sharedProviderCatalog(registry, { force: true, timeoutMs: 20 });
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    assert.deepEqual(byName['soak-ok'].models, [{ id: 'ok-model' }]);
    assert.equal(byName['soak-hung'].error.code, 'ETIMEDOUT');
    assert.ok(byName['soak-hung'].retryAt > Date.now());
  }
  assert.equal(stubborn.calls.length, 1, 'one call in the provider, not one per account change or revision');
  assert.equal(healthy.calls, 12);
  stubborn.calls[0].resolve([{ id: 'late-model' }]);
  await setImmediate();
  // Settled: the next load asks it again and takes its answer.
  const pending = sharedProviderCatalog(registry, { force: true, timeoutMs: 1_000 });
  await setImmediate();
  assert.equal(stubborn.calls.length, 2);
  stubborn.calls[1].resolve([{ id: 'hung-model' }]);
  const recovered = Object.fromEntries((await pending).map((entry) => [entry.name, entry]));
  assert.deepEqual(recovered['soak-hung'].models, [{ id: 'hung-model' }]);
  assert.deepEqual(
    pendingProviderCatalogOps().filter((name) => name.startsWith('soak-')),
    []
  );
});
