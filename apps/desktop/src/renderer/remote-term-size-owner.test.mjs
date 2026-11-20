// The phone's size claim over the real shim state: the host's `initialize.capabilities.remote.termSizeOwner` (read by peerFlagsOf, applied
// per connection by phone-boot) opens `remoteTermSizeOwner`, and only then the heartbeat and the 0x0 release leave for the host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { peerFlagsOf } from '../../../mobile/src/phone-capabilities.ts';
import { sendSizeOwnerHeartbeat, sendSizeOwnerRelease } from './terminal-size-owner.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const capabilities = (termSizeOwner) => ({ browser: { state: 'unavailable' }, remote: { termSizeOwner } });

test('a host that serves termSizeOwner lets the phone claim and release the PTY size; one that does not gets nothing', async () => {
  await withPhoneApi({ termResize: () => undefined }, async ({ ctx, api, calls }) => {
    assert.equal(api.remoteTermSizeOwner, false, 'before any handshake');
    sendSizeOwnerHeartbeat(api, 't1', 80, 24);
    assert.deepEqual(calls, []);

    Object.assign(ctx, peerFlagsOf(capabilities(true)));
    assert.equal(api.remoteTermSizeOwner, true);
    sendSizeOwnerHeartbeat(api, 't1', 80, 24);
    sendSizeOwnerRelease(api, 't1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      calls.map((c) => c.params),
      [
        ['t1', 80, 24, true],
        ['t1', 0, 0, true],
      ]
    );

    Object.assign(ctx, peerFlagsOf(capabilities(false)));
    assert.equal(api.remoteTermSizeOwner, false, 'a reconnect to a host without the flag');
    sendSizeOwnerRelease(api, 't1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 2);
  });
});
