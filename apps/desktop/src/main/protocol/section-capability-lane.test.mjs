import assert from 'node:assert/strict';
import test from 'node:test';

import { withSectionCapabilities } from './section-capability-lane.ts';

const entry = (section, key, value) => ({ section, key, revision: 1, value });

function fakeProtocol(entries) {
  const watchers = new Map();
  const calls = [];
  const protocol = {
    status: 'ready',
    snapshot: () => ({ status: 'ready', entries }),
    call: async (method, params) => void calls.push([method, params]),
    watchSection(section, listener) {
      const set = watchers.get(section) ?? new Set();
      watchers.set(section, set.add(listener));
      return () => set.delete(listener);
    },
  };
  const publish = (added) => {
    entries.push(added);
    [...(watchers.get(added.section) ?? [])].forEach((listener) => listener(added));
  };
  return { protocol, calls, publish };
}

function fakeLane() {
  const sent = [];
  return {
    sent,
    lane: {
      invoke: async (capability, args, sessionId) => (sent.push(['invoke', capability, args, sessionId]), { value: `lane:${capability}`, snapshot: 'held' }),
      read: async (requests) => (sent.push(['read', requests.map((request) => request.capability)]), requests.map((request) => ({ ok: true, value: `lane:${request.capability}` }))),
    },
  };
}

const snapshot = () => 'held';

test('the replaced capabilities are answered from the connection\'s sections', async () => {
  const { protocol } = fakeProtocol([
    entry('agents', null, [{ id: 'worker' }]),
    entry('providerSetup', null, { providers: [] }),
    entry('providerAccounts', 'openai-oauth', { accounts: [] }),
    entry('config', 'onboarding', { completed: false }),
  ]);
  const { lane, sent } = fakeLane();
  const wrapped = withSectionCapabilities({ lane, protocol, snapshot });
  assert.deepEqual(await wrapped.invoke('listAgents', [], undefined), { value: [{ id: 'worker' }], snapshot: 'held' });
  assert.deepEqual((await wrapped.invoke('getProviderAccounts', ['openai-oauth'], undefined)).value, { accounts: [] });
  assert.deepEqual((await wrapped.invoke('getOnboardingStatus', undefined, undefined)).value, { completed: false });
  assert.deepEqual(sent, [], 'the lane was never asked');
});

test('a section not published yet is waited for', async () => {
  const { protocol, publish } = fakeProtocol([]);
  const { lane } = fakeLane();
  const wrapped = withSectionCapabilities({ lane, protocol, snapshot });
  let settled = false;
  const answer = wrapped.invoke('listAgents', [], undefined).then((result) => ((settled = true), result));
  await Promise.resolve();
  assert.equal(settled, false);
  publish(entry('agents', null, [{ id: 'worker' }]));
  assert.deepEqual((await answer).value, [{ id: 'worker' }]);
});

test('an unknown provider and a closed connection are errors', async () => {
  const { protocol } = fakeProtocol([entry('providerAccounts', 'openai-oauth', {})]);
  const wrapped = withSectionCapabilities({ lane: fakeLane().lane, protocol, snapshot });
  await assert.rejects(wrapped.invoke('getProviderAccounts', ['nope'], undefined), /Unknown OAuth provider/);
  const closed = fakeProtocol([]);
  closed.protocol.status = 'closed';
  await assert.rejects(
    withSectionCapabilities({ lane: fakeLane().lane, protocol: closed.protocol, snapshot }).invoke('listWorkflows', [], undefined),
    /connection is closed/
  );
});

test('getProviderSetup options recompute the section first', async () => {
  const { protocol, calls } = fakeProtocol([entry('providerSetup', null, { providers: [] })]);
  const wrapped = withSectionCapabilities({ lane: fakeLane().lane, protocol, snapshot });
  await wrapped.invoke('getProviderSetup', [{ force: true }], undefined);
  await wrapped.invoke('getProviderSetup', [{}], undefined);
  assert.deepEqual(calls, [['account/refreshProviderSetup', { force: true }]]);
});

test('other capabilities and mixed reads keep the lane and the order', async () => {
  const { protocol } = fakeProtocol([entry('agents', null, [1]), entry('providerAccounts', 'openai-oauth', {})]);
  const { lane, sent } = fakeLane();
  const wrapped = withSectionCapabilities({ lane, protocol, snapshot });
  assert.deepEqual((await wrapped.invoke('getProfile', [], 's1')).value, 'lane:getProfile');
  const results = await wrapped.read([{ capability: 'getTheme' }, { capability: 'listAgents' }, { capability: 'getProviderAccounts', args: ['x'] }, { capability: 'getProfile' }]);
  assert.deepEqual(results.map((result) => (result.ok ? result.value : result.error)), ['lane:getTheme', [1], 'Unknown OAuth provider.', 'lane:getProfile']);
  assert.deepEqual(sent, [['invoke', 'getProfile', [], 's1'], ['read', ['getTheme', 'getProfile']]]);
});

test('a lane method that is not a section capability reaches the wrapped lane', async () => {
  const { protocol } = fakeProtocol([]);
  const { lane } = fakeLane();
  const calls = [];
  lane.stopShellJob = async (sessionId, taskId) => (calls.push([sessionId, taskId]), { stopped: true });
  lane.getQuotaAutoResume = async () => true;
  const wrapped = withSectionCapabilities({ lane, protocol, snapshot });
  assert.deepEqual(await wrapped.stopShellJob('s1', 't1'), { stopped: true });
  assert.equal(await wrapped.getQuotaAutoResume(), true);
  assert.deepEqual(calls, [['s1', 't1']]);
});
