// Per-agent connector methods reach the host the same way over IPC (the
// desktop's invokeCapability / readCapabilities) and over remote access (a
// paired phone calls the same remote methods): same validation, same host call.
import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityRequest } from './ipc-capability-request.ts';

test('a wrong argument count is refused before the host is reached', () => {
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectors', args: ['a'] }), TypeError);
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setAgentConnectorToolPermission', args: ['a', 'b'] }),
    TypeError
  );
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'listConnectors', args: ['x'] }), TypeError);
});
