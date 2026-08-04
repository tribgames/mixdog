import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beforeEach, test } from 'node:test';

const {
  SIDEBAR_REFERENCE_KEYS,
  adoptSidebarReferenceHost,
  hasSidebarReference,
  invalidateSidebarReference,
  invalidateSidebarReferenceForMutation,
  isSidebarReferenceStale,
  isSidebarReferenceHost,
  loadSidebarReferences,
  prewarmSidebarReferences,
  publishSidebarProjects,
  readSidebarReference,
  resetSidebarReferenceCache,
  sidebarReferenceKeysForMutation,
  subscribeSidebarReferences,
  updateSidebarReference,
} = await import('./sidebar-reference-cache.ts');

let now = 1_000_000;

// A host stub that counts every wire call, so "one request per key" and
// "no request at all" are both directly observable.
function referenceApi({ scheduleName = 'daily' } = {}) {
  const counts = {};
  const state = {
    fail: '',
    setup: {
      channel: { discordChannelId: '111' },
      schedules: [{ name: scheduleName, enabled: true }],
      webhooks: [],
    },
    workflows: [{ id: 'default', name: 'Solo' }],
  };
  const bump = (name) => {
    counts[name] = (counts[name] || 0) + 1;
  };
  const api = {
    invokeCapability: async ({ capability }) => {
      bump(capability);
      if (state.fail) throw new Error(state.fail);
      if (capability === 'getChannelSetup') return { value: state.setup };
      if (capability === 'listWorkflows') return { value: state.workflows };
      if (capability === 'listAgents') return { value: [{ id: 'worker' }] };
      if (capability === 'getSearchRoute') return { value: { provider: 'openai', model: 'gpt' } };
      if (capability === 'listSearchModels') return { value: [{ provider: 'openai', model: 'gpt' }] };
      if (capability === 'getProviderSetup') return { value: { openai: { configured: true } } };
      return { value: null };
    },
    listProviderModels: async () => {
      bump('listProviderModels');
      if (state.fail) throw new Error(state.fail);
      return [{
        provider: 'openai', model: 'gpt-test', display: 'GPT Test',
        effortOptions: [], fastCapable: false, fastPreferred: false,
      }];
    },
    listProjects: async () => {
      bump('listProjects');
      if (state.fail) throw new Error(state.fail);
      return [{ name: 'demo', path: '/demo', alias: null }];
    },
  };
  return { api, counts, state };
}

beforeEach(() => {
  now = 1_000_000;
  resetSidebarReferenceCache({ now: () => now });
});

test('boot prewarm fills every reference key once and leaves panel loads free', async () => {
  const { api, counts } = referenceApi();
  await prewarmSidebarReferences(api);

  for (const key of SIDEBAR_REFERENCE_KEYS) {
    assert.equal(hasSidebarReference(key), true, `${key} must be prewarmed`);
  }
  assert.deepEqual(counts, {
    getChannelSetup: 1,
    listProviderModels: 1,
    listProjects: 1,
    listWorkflows: 1,
    listAgents: 1,
    getProviderSetup: 1,
    getSearchRoute: 1,
    listSearchModels: 1,
  });

  // A panel mounting after boot reads through with zero extra wire calls.
  await loadSidebarReferences(api, ['channelSetup', 'quickProviderModels', 'projects', 'workflows']);
  assert.equal(counts.getChannelSetup, 1);
  assert.equal(counts.listWorkflows, 1);
});

test('boot chunk warmup chains the low-priority reference prewarm', async () => {
  const source = await readFile(new URL('./app-idle-warmup.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /Promise\.allSettled\(\[[\s\S]*?\]\)\.then\(\(\) => \{[\s\S]*?startSidebarReferencePrewarm\(\)/,
    'reference prewarm must start only after the chunk warmup settles',
  );
  assert.match(source, /requestIdleCallback/, 'prewarm must ride an idle slot');
  assert.doesNotMatch(source, /localStorage/, 'boot warmup must not persist reference data');
});

test('overlapping panels share one in-flight request per key', async () => {
  const { api, counts } = referenceApi();
  // Schedules, Webhooks and Workflows mounting together (App pre-mounts rail
  // destinations) previously issued three getChannelSetup/listWorkflows pairs.
  const schedules = loadSidebarReferences(api, ['channelSetup', 'quickProviderModels', 'projects', 'workflows']);
  const webhooks = loadSidebarReferences(api, ['channelSetup', 'quickProviderModels', 'projects', 'workflows']);
  const workflows = loadSidebarReferences(api, ['workflows', 'agents', 'searchRoute']);
  await Promise.all([schedules, webhooks, workflows]);

  assert.equal(counts.getChannelSetup, 1);
  assert.equal(counts.listWorkflows, 1);
  assert.equal(counts.listProviderModels, 1);
  assert.equal(counts.listProjects, 1);
  assert.equal(counts.listAgents, 1);
});

test('TTL expiry revalidates without dropping the cached snapshot', async () => {
  const { api, counts, state } = referenceApi();
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(readSidebarReference('channelSetup').schedules.length, 1);

  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(counts.getChannelSetup, 1, 'fresh entries never refetch');

  now += 30_000;
  assert.equal(isSidebarReferenceStale('channelSetup'), true);
  state.setup = { ...state.setup, schedules: [{ name: 'daily' }, { name: 'weekly' }] };
  const pending = loadSidebarReferences(api, ['channelSetup']);
  // Mid-revalidation the panel still reads the previous rows: no blanking.
  assert.equal(readSidebarReference('channelSetup').schedules.length, 1);
  await pending;
  assert.equal(counts.getChannelSetup, 2);
  assert.equal(readSidebarReference('channelSetup').schedules.length, 2);
});

test('mutation invalidation refetches the affected keys and notifies subscribers', async () => {
  const { api, counts, state } = referenceApi();
  await loadSidebarReferences(api, ['channelSetup', 'workflows']);
  let notified = 0;
  const unsubscribe = subscribeSidebarReferences(['channelSetup'], () => {
    notified += 1;
  });

  assert.deepEqual(
    sidebarReferenceKeysForMutation('saveSchedule', ['channelSetup', 'workflows']),
    ['channelSetup'],
  );
  assert.deepEqual(sidebarReferenceKeysForMutation('unmappedMutation', ['channelSetup']), ['channelSetup']);

  state.setup = { ...state.setup, schedules: [{ name: 'daily' }, { name: 'nightly' }] };
  invalidateSidebarReference(...sidebarReferenceKeysForMutation('saveSchedule', ['channelSetup']));
  // Invalidation keeps the rows readable until the refetch lands.
  assert.equal(readSidebarReference('channelSetup').schedules.length, 1);
  await loadSidebarReferences(api, ['channelSetup', 'workflows']);

  assert.equal(counts.getChannelSetup, 2);
  assert.equal(counts.listWorkflows, 1, 'an unrelated key stays cached');
  assert.equal(readSidebarReference('channelSetup').schedules.length, 2);
  assert.equal(notified >= 1, true);
  unsubscribe();

  updateSidebarReference('channelSetup', { schedules: [{ name: 'direct' }] });
  assert.equal(readSidebarReference('channelSetup').schedules[0].name, 'direct');
});

test('a failed revalidation keeps the stale snapshot and reports the error', async () => {
  const { api, state } = referenceApi();
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(readSidebarReference('channelSetup').schedules.length, 1);

  now += 30_000;
  state.fail = 'host offline';
  const outcome = await loadSidebarReferences(api, ['channelSetup']);
  assert.match(outcome.error, /host offline/);
  assert.equal(
    readSidebarReference('channelSetup').schedules.length,
    1,
    'a failure must never blank a panel',
  );

  state.fail = '';
  now += 5_000;
  const recovered = await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(recovered.error, '');
  assert.equal(readSidebarReference('channelSetup').schedules.length, 1);
});

test('a different host identity drops the cached snapshots', async () => {
  const first = referenceApi({ scheduleName: 'first' });
  await loadSidebarReferences(first.api, ['channelSetup']);
  assert.equal(readSidebarReference('channelSetup').schedules[0].name, 'first');

  const second = referenceApi({ scheduleName: 'second' });
  await loadSidebarReferences(second.api, ['channelSetup']);
  assert.equal(readSidebarReference('channelSetup').schedules[0].name, 'second');
});

test('adoption drops the previous host BEFORE any read can observe it', async () => {
  const first = referenceApi({ scheduleName: 'first' });
  await loadSidebarReferences(first.api, ['channelSetup', 'workflows']);
  assert.equal(hasSidebarReference('channelSetup'), true);

  const second = referenceApi({ scheduleName: 'second' });
  // Synchronous adoption is what a render-phase read depends on: the moment
  // the new host is bound, host A's snapshot is unreadable.
  assert.equal(adoptSidebarReferenceHost(second.api), true);
  assert.equal(hasSidebarReference('channelSetup'), false);
  assert.deepEqual(readSidebarReference('channelSetup'), {});
  assert.deepEqual(readSidebarReference('workflows'), []);
  assert.equal(adoptSidebarReferenceHost(second.api), false, 'the same host never re-clears');
});

test('a late response from the previous host is ignored after a rebind', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const stale = {
    invokeCapability: async ({ capability }) => {
      if (capability !== 'getChannelSetup') return { value: null };
      await gate;
      return { value: { schedules: [{ name: 'ghost' }] } };
    },
  };
  const pending = loadSidebarReferences(stale, ['channelSetup']);

  const next = referenceApi({ scheduleName: 'current' });
  adoptSidebarReferenceHost(next.api);
  release();
  await pending;
  assert.equal(hasSidebarReference('channelSetup'), false,
    'the previous host response must not populate the new host cache');

  await loadSidebarReferences(next.api, ['channelSetup']);
  assert.equal(readSidebarReference('channelSetup').schedules[0].name, 'current');
});

test('rebinding to an unavailable host clears state and stays quiet', async () => {
  const { api } = referenceApi();
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(hasSidebarReference('channelSetup'), true);

  const outcome = await loadSidebarReferences(undefined, ['channelSetup']);
  assert.deepEqual(outcome, { error: '' });
  assert.equal(hasSidebarReference('channelSetup'), false);
  assert.deepEqual(readSidebarReference('channelSetup'), {});
});

test('a partial host serves what it can without failing the rest', async () => {
  const counts = {};
  const partial = {
    invokeCapability: async ({ capability }) => {
      counts[capability] = (counts[capability] || 0) + 1;
      if (capability === 'getChannelSetup') return { value: { schedules: [] } };
      return { value: null };
    },
  };
  const outcome = await loadSidebarReferences(partial, ['channelSetup', 'quickProviderModels', 'projects']);

  assert.equal(outcome.error, '');
  assert.equal(counts.getChannelSetup, 1);
  // No listProviderModels/listProjects bridge: those keys resolve to the empty
  // catalogs instead of erroring or retrying.
  assert.deepEqual(readSidebarReference('quickProviderModels'), []);
  assert.deepEqual(readSidebarReference('projects'), []);
  assert.equal(hasSidebarReference('projects'), true);
});

test('a cold failure backs off instead of storming on every mount', async () => {
  const { api, counts, state } = referenceApi();
  state.fail = 'host offline';
  // Nothing was ever cached: the backoff has to live outside the snapshot map.
  const first = await loadSidebarReferences(api, ['channelSetup']);
  assert.match(first.error, /host offline/);
  assert.equal(hasSidebarReference('channelSetup'), false);

  await loadSidebarReferences(api, ['channelSetup']);
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(counts.getChannelSetup, 1, 'repeated mounts inside the backoff must not refetch');

  now += 3_000;
  state.fail = '';
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(counts.getChannelSetup, 2);
  assert.equal(readSidebarReference('channelSetup').schedules.length, 1);
});

test('an explicit invalidation outranks the failure backoff', async () => {
  const { api, counts, state } = referenceApi();
  state.fail = 'host offline';
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(counts.getChannelSetup, 1);

  state.fail = '';
  invalidateSidebarReference('channelSetup');
  await loadSidebarReferences(api, ['channelSetup']);
  assert.equal(counts.getChannelSetup, 2);
});

test('provider mutations invalidate only the provider-derived keys', async () => {
  const { api, counts } = referenceApi();
  await prewarmSidebarReferences(api);

  assert.equal(invalidateSidebarReferenceForMutation('saveProviderApiKey'), true);
  assert.equal(isSidebarReferenceStale('providerSetup'), true);
  assert.equal(isSidebarReferenceStale('quickProviderModels'), true);
  assert.equal(isSidebarReferenceStale('searchModels'), true);
  assert.equal(isSidebarReferenceStale('channelSetup'), false);
  assert.equal(isSidebarReferenceStale('workflows'), false);
  assert.equal(isSidebarReferenceStale('searchRoute'), false, 'a stored route is not provider state');

  await loadSidebarReferences(api, SIDEBAR_REFERENCE_KEYS);
  assert.equal(counts.getProviderSetup, 2);
  assert.equal(counts.listProviderModels, 2);
  assert.equal(counts.listSearchModels, 2);
  assert.equal(counts.listWorkflows, 1);
  assert.equal(counts.getChannelSetup, 1);

  // Unmapped capabilities never trigger a broad sweep.
  assert.equal(invalidateSidebarReferenceForMutation('setZoomFactor'), false);
  assert.equal(isSidebarReferenceStale('providerSetup'), false);
});

test('an absent key hands every reader the same empty snapshot', () => {
  assert.equal(readSidebarReference('workflows'), readSidebarReference('workflows'));
  assert.equal(readSidebarReference('channelSetup'), readSidebarReference('channelSetup'));
  assert.equal(readSidebarReference('providerSetup'), undefined);
});

test('a mutation completion from the previous host cannot re-adopt it', async () => {
  const first = referenceApi({ scheduleName: 'first' });
  await loadSidebarReferences(first.api, ['channelSetup']);
  const second = referenceApi({ scheduleName: 'second' });
  await loadSidebarReferences(second.api, ['channelSetup']);
  assert.equal(isSidebarReferenceHost(first.api), false);
  assert.equal(isSidebarReferenceHost(second.api), true);

  // This is the shape of a slow mutation refresh captured for host A.
  const outcome = await loadSidebarReferences(first.api, ['channelSetup'], { onlyIfBound: true });
  assert.deepEqual(outcome, { error: '', superseded: true });
  assert.equal(first.counts.getChannelSetup, 1, 'host A must not be queried again');
  assert.equal(readSidebarReference('channelSetup').schedules[0].name, 'second');
  assert.equal(isSidebarReferenceHost(second.api), true, 'the bound host is untouched');
});

test('external invalidation wakes each subscriber exactly once, off the mutation path', async () => {
  const { api } = referenceApi();
  await prewarmSidebarReferences(api);
  let calls = 0;
  const unsubscribe = subscribeSidebarReferences(
    ['providerSetup', 'quickProviderModels', 'searchModels'],
    () => { calls += 1; },
  );

  invalidateSidebarReferenceForMutation('saveProviderApiKey');
  assert.equal(calls, 0, 'notification must never run synchronously inside the mutation');
  await Promise.resolve();
  assert.equal(calls, 1, 'three invalidated keys coalesce into one wake-up');

  invalidateSidebarReference('workflows');
  await Promise.resolve();
  assert.equal(calls, 1, 'a key this subscriber does not watch stays quiet');
  unsubscribe();
});

test('completeOnboarding invalidates the routes and provider state it writes', async () => {
  const { api } = referenceApi();
  await prewarmSidebarReferences(api);

  assert.deepEqual(sidebarReferenceKeysForMutation('completeOnboarding'),
    ['searchRoute', 'agents', 'providerSetup', 'quickProviderModels', 'searchModels']);
  assert.equal(invalidateSidebarReferenceForMutation('completeOnboarding'), true);
  assert.equal(isSidebarReferenceStale('searchRoute'), true);
  assert.equal(isSidebarReferenceStale('agents'), true);
  assert.equal(isSidebarReferenceStale('providerSetup'), true);
  assert.equal(isSidebarReferenceStale('workflows'), false);
  assert.equal(isSidebarReferenceStale('channelSetup'), false);
});

test('the app project catalog publishes into the cache without a round trip', async () => {
  const { api, counts } = referenceApi();
  const list = [{ name: 'demo', path: '/demo', alias: null }];
  assert.equal(publishSidebarProjects(list), true);
  assert.deepEqual(readSidebarReference('projects'), list);

  // An equal list (a plain re-render) must not churn the cache.
  assert.equal(publishSidebarProjects([{ name: 'demo', path: '/demo', alias: null }]), false);
  // A successful rename in the app shell changes the list, so it publishes.
  assert.equal(publishSidebarProjects([{ name: 'demo', path: '/demo', alias: 'Demo' }]), true);
  assert.equal(readSidebarReference('projects')[0].alias, 'Demo');

  await loadSidebarReferences(api, ['projects']);
  assert.equal(counts.listProjects, undefined, 'a published catalog is already fresh');
});
