import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayClientCallDispatch, remoteCallQueueKey, remoteCallStatName } from './remote-relay-client-calls.ts';

test('capability calls are named by their allow-listed capabilities, never by arguments', () => {
  assert.equal(
    remoteCallStatName('invokeCapability', [
      { capability: 'getTurnReviewDiff', args: [{ refresh: true }], sessionId: 's' },
    ]),
    'invokeCapability:getTurnReviewDiff'
  );
  // A re-read carrying its held tag is counted apart; the tag itself never is.
  const tagged = remoteCallStatName('invokeCapability', [
    { capability: 'getTurnReviewDiff', args: [{ refresh: true, known: 'f'.repeat(32) }], sessionId: 's' },
  ]);
  assert.equal(tagged, 'invokeCapability:getTurnReviewDiff+tagged');
  assert.doesNotMatch(tagged, /f{8}/);
  assert.equal(
    remoteCallStatName('readCapabilities', [[{ capability: 'getTheme' }, { capability: 'getProfile' }]]),
    'readCapabilities:getTheme+getProfile'
  );
  assert.equal(
    remoteCallStatName('invokeCapability', [{ capability: 'secret-token-value' }]),
    'invokeCapability:unknown'
  );
  assert.equal(remoteCallStatName('listProjects', []), 'listProjects');
});

test('the per-minute call record carries the capability name', async () => {
  const recorded = [];
  const client = { pendingFrames: 0, callQueue: { run: (_method, task) => task() } };
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods: { invokeCapability: async () => ({ value: true }) },
    attached: () => true,
    live: () => true,
    sendEncryptedFrame: async (_clientId, _payload, _droppable, onSent) => onSent?.(120),
    acknowledgePaintProbe: () => null,
    resyncClient() {},
    recordCall: (method, _ms, bytes) => recorded.push([method, bytes]),
  });
  const { execution } = await dispatch(
    'client-1',
    client,
    { id: 1, method: 'invokeCapability', params: [{ capability: 'getVoiceStatus', args: [] }] },
    240
  );
  await execution;
  assert.deepEqual(recorded, [['invokeCapability:getVoiceStatus', { requestBytes: 240, responseBytes: 120 }]]);
});

test('dictation calls are queued on their capability key, other capabilities on the method', async () => {
  const keys = [];
  const client = {
    pendingFrames: 0,
    callQueue: {
      run: (key, task) => {
        keys.push(key);
        return task();
      },
    },
  };
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods: { invokeCapability: async () => ({ value: true }) },
    attached: () => true,
    live: () => true,
    sendEncryptedFrame: async () => {},
    acknowledgePaintProbe: () => null,
    resyncClient() {},
    recordCall() {},
  });
  for (const [id, capability] of ['transcribeAudio', 'prepareTranscription', 'setAutoUpdate'].entries()) {
    const { execution } = await dispatch(
      'client-1',
      client,
      { id, method: 'invokeCapability', params: [{ capability, args: [] }] },
      10
    );
    await execution;
  }
  assert.deepEqual(keys, [
    'invokeCapability:transcribeAudio',
    'invokeCapability:prepareTranscription',
    'invokeCapability',
  ]);
});

test('a per-client method table answers only the client it was built for', async () => {
  const built = [];
  const sent = [];
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods: (clientId, client) => {
      built.push([clientId, client.credentialId]);
      return { whoami: async () => client.credentialId };
    },
    attached: () => true,
    live: () => true,
    sendEncryptedFrame: async (_clientId, payload) => sent.push(payload),
    acknowledgePaintProbe: () => null,
    resyncClient() {},
    recordCall() {},
  });
  for (const credentialId of ['cred-a', 'cred-b']) {
    const client = { pendingFrames: 0, credentialId, callQueue: { run: (_key, task) => task() } };
    const { execution } = await dispatch(`route-${credentialId}`, client, { id: 1, method: 'whoami', params: [] }, 10);
    await execution;
  }
  assert.deepEqual(built, [
    ['route-cred-a', 'cred-a'],
    ['route-cred-b', 'cred-b'],
  ]);
  assert.deepEqual(
    sent.map((frame) => frame.value),
    ['cred-a', 'cred-b']
  );
});

test('review reads and per-file patches pick the slow-read queue key', () => {
  const stat = (capability) => remoteCallStatName('invokeCapability', [{ capability, args: [], sessionId: 's' }]);
  for (const capability of ['getSessionReviewFilePatch', 'getTurnReviewFilePatch', 'getTurnChanges']) {
    assert.equal(remoteCallQueueKey('invokeCapability', stat(capability)), `invokeCapability:${capability}`);
  }
  assert.equal(
    remoteCallQueueKey('invokeCapability', stat('getTurnReviewDiff') + '+tagged'),
    'invokeCapability:getTurnReviewDiff'
  );
  for (const method of ['gitReview', 'gitReviewDiff', 'gitReviewDiffs', 'getSnapshot']) {
    assert.equal(remoteCallQueueKey(method, method), method);
  }
});

test('read-only capability calls read; quota and usage sweeps take the slow-read lane', () => {
  const invoke = (capability) => remoteCallStatName('invokeCapability', [{ capability, args: [], sessionId: 's' }]);
  const read = (...capabilities) =>
    remoteCallStatName('readCapabilities', [capabilities.map((capability) => ({ capability, args: [] }))]);
  for (const capability of ['getVoiceStatus', 'skillsStatus', 'getProviderSetup', 'listWorkflows']) {
    assert.equal(remoteCallQueueKey('invokeCapability', invoke(capability)), 'readCapabilities');
  }
  assert.equal(remoteCallQueueKey('readCapabilities', read('skillsStatus', 'mcpStatus')), 'readCapabilities');
  for (const capability of ['getUsageDashboard', 'getQuotaHistory', 'getUsageStats']) {
    assert.equal(remoteCallQueueKey('invokeCapability', invoke(capability)), 'readCapabilities:slow');
    assert.equal(remoteCallQueueKey('readCapabilities', read('skillsStatus', capability)), 'readCapabilities:slow');
  }
  // A mutation, or a name outside the allow-list, stays an ordered barrier.
  assert.equal(remoteCallQueueKey('invokeCapability', invoke('setAutoUpdate')), 'invokeCapability');
  assert.equal(remoteCallQueueKey('invokeCapability', invoke('no-such-capability')), 'invokeCapability');
  assert.equal(remoteCallQueueKey('invokeCapability', 'invokeCapability'), 'invokeCapability');
});
