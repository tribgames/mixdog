import assert from 'node:assert/strict';
import test from 'node:test';

import { isSectionCapability, providerSetupRefresh, sectionOf } from '../shared/section-capabilities.ts';
import { invokeOrHeld, readHeldCapability, readOrHeld } from './section-capabilities.ts';
import { createSectionStore } from './section-store.ts';
import { wasPrioritized } from './prioritized-answer.ts';

const entry = (section, key, value) => ({ section, key, revision: 1, value });

/** A store over a source whose pushes the test controls. */
async function storeWith(entries) {
  const listeners = new Set();
  const store = createSectionStore({
    snapshot: async () => ({ status: 'ready', entries }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  await store.ready();
  const push = (...added) =>
    listeners.forEach((listener) =>
      listener({ kind: 'sections', changes: added.map((e) => ({ section: e.section, key: e.key, entry: e })) })
    );
  return { store, push };
}

const SECTIONS = [
  entry('presets', null, [{ id: 'lead', provider: 'openai', model: 'gpt-5' }]),
  entry('agents', null, [{ id: 'worker', label: 'Worker' }]),
  entry('workflows', null, [{ id: 'default', name: 'Default', active: true }]),
  entry('webSearch', null, { provider: 'openai', model: 'gpt-5' }),
  entry('providerSetup', null, { providers: [], pendingSecrets: false }),
  entry('providerAccounts', 'openai-oauth', { provider: 'openai-oauth', accounts: [] }),
  entry('config', 'onboarding', { completed: true, version: 3, default: 'lead', workflowRoutes: { lead: {} }, starterGuide: null }),
];

const coreSource = (store, recomputed = []) => ({
  core: async () => true,
  store: () => store,
  recompute: async (params) => void recomputed.push(params),
});
const nodeSource = () => ({
  core: async () => false,
  store: () => assert.fail('a Node-hosted window never reads the store'),
  recompute: async () => assert.fail('a Node-hosted window never recomputes'),
});

test('the sections carry the capabilities they replaced', () => {
  assert.deepEqual(sectionOf('listPresets'), { section: 'presets', key: null });
  assert.deepEqual(sectionOf('getProviderSetup', [{}]), { section: 'providerSetup', key: null });
  assert.deepEqual(sectionOf('getProviderAccounts', ['openai-oauth']), { section: 'providerAccounts', key: 'openai-oauth' });
  assert.deepEqual(sectionOf('getOnboardingStatus'), { section: 'config', key: 'onboarding' });
  assert.throws(() => sectionOf('getProviderAccounts', []), /Unknown OAuth provider/);
  assert.equal(isSectionCapability('getProfile'), false);
  assert.deepEqual(providerSetupRefresh('getProviderSetup', [{ force: true, unlockKeychain: true, other: 1 }]), { force: true, unlockKeychain: true });
  assert.equal(providerSetupRefresh('getProviderSetup', [{}]), undefined);
  assert.equal(providerSetupRefresh('listAgents', [{ force: true }]), undefined);
});

test('a core connection answers a replaced capability from its section, as pushed', async () => {
  const { store } = await storeWith(SECTIONS);
  const source = coreSource(store);
  for (const [capability, args, section] of [
    ['listPresets', [], SECTIONS[0]],
    ['listAgents', [], SECTIONS[1]],
    ['listWorkflows', [], SECTIONS[2]],
    ['getWebSearchRoute', [], SECTIONS[3]],
    ['getProviderSetup', [{}], SECTIONS[4]],
    ['getProviderAccounts', ['openai-oauth'], SECTIONS[5]],
    ['getOnboardingStatus', [], SECTIONS[6]],
  ]) {
    assert.deepEqual(await readHeldCapability(capability, args, source), { value: section.value }, capability);
  }
  assert.equal(await readHeldCapability('getProfile', [], source), undefined);
});

test('a core connection waits for a section that is not published yet, and never asks the host', async () => {
  const { store, push } = await storeWith([]);
  const asked = [];
  const api = { invokeCapability: async (request) => void asked.push(request.capability) };
  let settled = false;
  const answer = invokeOrHeld(api, { capability: 'listAgents' }, coreSource(store)).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  push(SECTIONS[1]);
  assert.deepEqual(await answer, { value: SECTIONS[1].value });
  assert.deepEqual(asked, []);
});

test('a provider the core did not publish is an error, not a request', async () => {
  const { store } = await storeWith(SECTIONS);
  await assert.rejects(readHeldCapability('getProviderAccounts', ['nope'], coreSource(store)), /Unknown OAuth provider/);
  const results = await readOrHeld({ readCapabilities: async () => assert.fail('nothing to ask the host') }, [
    { capability: 'getProviderAccounts', args: ['nope'] },
    { capability: 'listAgents' },
  ], coreSource(store));
  assert.deepEqual(results, [{ ok: false, error: 'Unknown OAuth provider.' }, { ok: true, value: SECTIONS[1].value }]);
});

test('getProviderSetup options recompute the section before it is read', async () => {
  const { store } = await storeWith(SECTIONS);
  const recomputed = [];
  const source = coreSource(store, recomputed);
  await readHeldCapability('getProviderSetup', [{ force: true, unlockKeychain: true }], source);
  await readHeldCapability('getProviderSetup', [{ recheckKeychain: true }], source);
  await readHeldCapability('getProviderSetup', [{}], source);
  await readHeldCapability('listAgents', [{ force: true }], source);
  assert.deepEqual(recomputed, [{ force: true, unlockKeychain: true }, { recheckKeychain: true }]);
});

test('a Node-hosted connection asks the host for every capability', async () => {
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
  assert.deepEqual(await invokeOrHeld(api, { capability: 'listAgents' }, nodeSource()), { value: 'host:listAgents', snapshot: null });
  const results = await readOrHeld(api, [{ capability: 'getProviderSetup' }, { capability: 'getTheme' }], nodeSource());
  assert.deepEqual(results, [{ ok: true, value: 'host:getProviderSetup' }, { ok: true, value: 'host:getTheme' }]);
  assert.deepEqual(sent, [['invoke', 'listAgents'], ['read', ['getProviderSetup', 'getTheme']]]);
});

test('on a core connection a capability the sections did not replace still goes to the core lane', async () => {
  const { store } = await storeWith(SECTIONS);
  const sent = [];
  const api = { invokeCapability: async (request) => (sent.push(request.capability), { value: 1, snapshot: null }) };
  assert.deepEqual(await invokeOrHeld(api, { capability: 'getProfile' }, coreSource(store)), { value: 1, snapshot: null });
  assert.deepEqual(sent, ['getProfile']);
});

test('prioritizeQueued is taken for Node\'s count or the core\'s turn/steer answer', () => {
  assert.equal(wasPrioritized({ count: 1, ids: ['q1'], priority: 'now' }), true);
  assert.equal(wasPrioritized({ accepted: true, queuedId: 'q1' }), true);
  assert.equal(wasPrioritized({ count: 0, ids: [], priority: 'now' }), false);
  assert.equal(wasPrioritized(undefined), false);
});
