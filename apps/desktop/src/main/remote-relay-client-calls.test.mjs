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
