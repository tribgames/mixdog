import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayEnvelopeDispatcher } from './remote-relay-envelope.ts';

function dispatcher() {
  const pairCode = [];
  const dispatch = createRelayEnvelopeDispatcher({
    control: { settle: () => false },
    onCapabilities() {},
    onClientClaim() {},
    onClientOpen() {},
    onClientClose() {},
    onMedia() {},
    onPairCode: (envelope) => pairCode.push(envelope.type),
  });
  return { dispatch, pairCode };
}

test('pair-code answers from the relay reach the pair-code manager', () => {
  const { dispatch, pairCode } = dispatcher();
  dispatch({ type: 'pair-code-issued', lease: 'l1', ok: true, code: '123456', expiresInMs: 300000 });
  dispatch({ type: 'pair-code-used', lease: 'l1' });
  assert.deepEqual(pairCode, ['pair-code-issued', 'pair-code-used']);
});
