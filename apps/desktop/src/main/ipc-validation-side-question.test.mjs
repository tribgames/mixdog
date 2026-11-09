import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_CONFIGURE_ACTIONS } from './test-support/session-protocol-actions.recorded.mjs';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';
test('/btw capabilities: askSide takes one question, cancelSide nothing', () => {
  for (const capability of ['askSide', 'cancelSide']) {
    assert.equal(DESKTOP_CAPABILITIES.includes(capability), true);
    assert.equal(DESKTOP_READ_CAPABILITIES.includes(capability), false);
    assert.equal(SESSION_CONFIGURE_ACTIONS.includes(capability), true, 'routed through session.configure');
  }
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'askSide', args: ['Why?'], sessionId: 's' }), {
    capability: 'askSide',
    args: ['Why?'],
    sessionId: 's',
  });
  for (const args of [[], [''], ['   '], [3], ['a', 'b']]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'askSide', args }), TypeError);
  }
  assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability: 'cancelSide', sessionId: 's' }));
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'cancelSide', args: ['x'] }), TypeError);
  assert.throws(
    () => requiredDesktopCapabilityReadRequests([{ capability: 'askSide', args: ['Why?'] }]),
    /not read-only/
  );
});
