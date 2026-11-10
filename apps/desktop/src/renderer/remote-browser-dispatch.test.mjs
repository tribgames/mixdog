import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

// Node's version (b6f10295a) had two tests here. The first fed pushed browser frames and open requests through the relay socket and checked
// that only authenticated, well-formed ones reach `onRemoteBrowserFrame` / `onBrowserOpenRequested`. That path is gone with the Node frame
// transport: nothing in the phone fills those listener sets until PH-2's browser adapter does, and the clear-relay-data rule is the
// connection's (apps/mobile/src/phone-client.test.ts). It is retired, and its validation belongs to that adapter's test.
// The second, kept below: stream start/stop are calls and the acks are fires, on Node's fixed method names.
test('stream start/stop use call and acks use fire on the fixed relay methods', async () => {
  await withPhoneApi({ browserRemoteStream: () => undefined, browserRemoteStreamAck: () => undefined }, async ({ api, calls }) => {
    await api.remoteBrowserStream('s1', { maxWidth: 800, maxHeight: 600 });
    api.remoteBrowserStreamAck('s1', 7);
    await api.remoteBrowserStream('s1', null);
    assert.deepEqual(calls, [
      { method: 'browserRemoteStream', params: ['s1', { maxWidth: 800, maxHeight: 600 }] },
      { method: 'browserRemoteStreamAck', params: ['s1', 7] },
      { method: 'browserRemoteStream', params: ['s1', null] },
    ]);
  });
});
