import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayClientCallDispatch, remoteCallStatName } from './remote-relay-client-calls.ts';

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
  for (const [id, capability] of ['transcribeAudio', 'prepareTranscription', 'getVoiceStatus'].entries()) {
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
