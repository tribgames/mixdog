import assert from 'node:assert/strict';
import test from 'node:test';

import { createProfileSettings } from '../../../../src/session-runtime/settings-profile-api.mjs';
import {
  heldCapability,
  invokeOrHeld,
  isSectionCapability,
  onboardingStatusOf,
  readHeldCapability,
  readOrHeld,
} from './section-capabilities.ts';
import { createSectionStore } from './section-store.ts';
import { wasPrioritized } from './prioritized-answer.ts';

async function storeWith(entries) {
  const store = createSectionStore({
    snapshot: async () => ({ status: 'ready', entries }),
    subscribe: () => () => undefined,
  });
  await store.ready();
  return store;
}

const entry = (section, key, value) => ({ section, key, revision: 1, value });

const SECTIONS = [
  entry('presets', null, [{ id: 'lead', provider: 'openai', model: 'gpt-5' }]),
  entry('agents', null, [{ id: 'worker', label: 'Worker' }]),
  entry('workflows', null, [{ id: 'default', name: 'Default', active: true }]),
  entry('webSearch', null, { provider: 'openai', model: 'gpt-5' }),
  entry('providerSetup', null, { providers: [], pendingSecrets: false }),
  entry('providerAccounts', 'openai-oauth', { provider: 'openai-oauth', accounts: [] }),
];

test('a replaced capability is answered from the section that carries its value', async () => {
  const store = await storeWith(SECTIONS);
  assert.deepEqual(heldCapability('listPresets', [], store), { value: SECTIONS[0].value });
  assert.deepEqual(heldCapability('listAgents', [], store), { value: SECTIONS[1].value });
  assert.deepEqual(heldCapability('listWorkflows', [], store), { value: SECTIONS[2].value });
  assert.deepEqual(heldCapability('getWebSearchRoute', [], store), { value: SECTIONS[3].value });
  assert.deepEqual(heldCapability('getProviderSetup', [{}], store), { value: SECTIONS[4].value });
  assert.deepEqual(heldCapability('getProviderAccounts', ['openai-oauth'], store), { value: SECTIONS[5].value });
  assert.equal(heldCapability('getProviderAccounts', ['anthropic'], store), undefined);
  assert.equal(heldCapability('getProviderAccounts', [], store), undefined);
});

test('a capability the sections did not replace is never held', async () => {
  const store = await storeWith(SECTIONS);
  assert.equal(isSectionCapability('getProfile'), false);
  assert.equal(heldCapability('getProfile', [], store), undefined);
});

test('a store without the section, or no store, holds nothing', async () => {
  assert.equal(heldCapability('listAgents', [], await storeWith([])), undefined);
  assert.equal(heldCapability('listAgents', [], undefined), undefined);
});

test('the onboarding status reads the agent subtree the way getOnboardingStatus reads the config', async () => {
  const configs = [
    {},
    { onboarding: { completed: true, version: 3, completedAt: 'then' } },
    { default: 'lead', onboarding: { completed: false, starterGuide: { closed: true, welcomed: false, visited: ['remote', 'bogus', 'provider'] } } },
    { onboarding: { completed: 'yes', version: 0, starterGuide: 'junk' } },
    { default: '', onboarding: { starterGuide: {} } },
  ];
  for (const config of configs) {
    const profile = createProfileSettings({
      getConfig: () => config,
      summarizeWorkflowRoutes: () => ({}),
      ONBOARDING_VERSION: 1,
    });
    const { workflowRoutes: _routes, ...node } = profile.getOnboardingStatus();
    assert.deepEqual(onboardingStatusOf(config), node, JSON.stringify(config));
    const store = await storeWith([entry('config', 'agent', config)]);
    assert.deepEqual(heldCapability('getOnboardingStatus', [], store), { value: node });
  }
});

test('getProviderSetup options recompute the section before it is read', async () => {
  const store = await storeWith(SECTIONS);
  const calls = [];
  const recompute = async (params) => calls.push(params);
  await readHeldCapability('getProviderSetup', [{ force: true, unlockKeychain: true, other: 1 }], store, recompute);
  await readHeldCapability('getProviderSetup', [{ recheckKeychain: true }], store, recompute);
  await readHeldCapability('getProviderSetup', [{}], store, recompute);
  await readHeldCapability('getProviderSetup', [], store, recompute);
  await readHeldCapability('listAgents', [{ force: true }], store, recompute);
  assert.deepEqual(calls, [{ force: true, unlockKeychain: true }, { recheckKeychain: true }]);
  const bare = await storeWith([]);
  await readHeldCapability('getProviderSetup', [{ force: true }], bare, recompute);
  assert.equal(calls.length, 2, 'a store without the section recomputes nothing');
});

test('invokeOrHeld and readOrHeld pass a capability the sections did not replace to the host', async () => {
  const sent = [];
  const api = {
    invokeCapability: async (request) => {
      sent.push(['invoke', request.capability]);
      return { value: `host:${request.capability}`, snapshot: null };
    },
    readCapabilities: async (requests) => {
      sent.push(['read', requests.map((request) => request.capability)]);
      return requests.map((request) => ({ ok: true, value: `host:${request.capability}` }));
    },
  };
  assert.deepEqual(await invokeOrHeld(api, { capability: 'getProfile' }), { value: 'host:getProfile', snapshot: null });
  assert.deepEqual(sent, [['invoke', 'getProfile']]);
  sent.length = 0;
  const results = await readOrHeld(api, [{ capability: 'getProfile' }, { capability: 'getTheme' }]);
  assert.deepEqual(results, [
    { ok: true, value: 'host:getProfile' },
    { ok: true, value: 'host:getTheme' },
  ]);
  assert.deepEqual(sent, [['read', ['getProfile', 'getTheme']]]);
});

test('prioritizeQueued is taken for Node\'s count or the core\'s turn/steer answer', () => {
  assert.equal(wasPrioritized({ count: 1, ids: ['q1'], priority: 'now' }), true);
  assert.equal(wasPrioritized({ accepted: true, queuedId: 'q1' }), true);
  assert.equal(wasPrioritized({ count: 0, ids: [], priority: 'now' }), false);
  assert.equal(wasPrioritized(undefined), false);
});
