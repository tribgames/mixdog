import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteWebrtcRelayInputOrder } from '../../shared/remote-webrtc.ts';
import { createRemoteRelayInputOrder } from './input-order.ts';

const order = (run, seq, stream = 'q1') => ({ v: 1, stream, run, seq });

test('ordered relay input: repeats, older runs and a poisoned run are refused; a newer run clears it', () => {
  const o = createRemoteRelayInputOrder();
  const admit = (value) => o.admit('c1', 's1', value).dispatch;
  assert.equal(admit(order(1, 1)), true);
  assert.equal(admit(order(1, 1)), false, 'a repeat is never applied twice');
  assert.equal(admit(order(1, 2)), true);
  o.failed('c1', 's1', order(1, 2));
  assert.equal(admit(order(1, 3)), false, 'nothing behind a failure of its run');
  assert.equal(admit(order(2, 4)), true, 'a newer run is adopted and clean');
  assert.equal(admit(order(1, 5)), false, 'an older run is refused');
  assert.equal(o.admit('c2', 's1', order(1, 1)).dispatch, true, 'per client');
  // A new stream starts fresh.
  assert.equal(admit(order(1, 1, 'q2')), true);
  o.dropClient('c1');
  assert.equal(admit(order(1, 1, 'q2')), true, 'a departed client is forgotten');
});

test('a malformed order is refused', () => {
  assert.deepEqual(parseRemoteWebrtcRelayInputOrder(order(1, 2)), order(1, 2));
  for (const bad of [null, { ...order(1, 2), v: 2 }, order(0, 1), order(1, 0), order(1, 1, 'bad id!')]) {
    assert.throws(() => parseRemoteWebrtcRelayInputOrder(bad));
  }
});
