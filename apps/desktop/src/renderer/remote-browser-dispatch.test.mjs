import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test('stream start/stop use call and acks use fire on the fixed relay methods', async () => {
  await withPhoneApi(
    { browserRemoteStream: () => undefined, browserRemoteStreamAck: () => undefined },
    async ({ api, calls }) => {
      await api.remoteBrowserStream('s1', { maxWidth: 800, maxHeight: 600 });
      api.remoteBrowserStreamAck('s1', 7);
      await api.remoteBrowserStream('s1', null);
      assert.deepEqual(calls, [
        { method: 'browserRemoteStream', params: ['s1', { maxWidth: 800, maxHeight: 600 }] },
        { method: 'browserRemoteStreamAck', params: ['s1', 7] },
        { method: 'browserRemoteStream', params: ['s1', null] },
      ]);
    }
  );
});
