import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeDiscoveryChanged } from './bridge-discovery.mjs';

test('a replacement advertisement is a different endpoint, never a missing file', () => {
  const current = { port: 1000, token: 'a' };
  assert.equal(bridgeDiscoveryChanged(current, { port: 1000, token: 'a' }), false);
  assert.equal(bridgeDiscoveryChanged(current, { port: 1001, token: 'a' }), true);
  assert.equal(bridgeDiscoveryChanged(current, { port: 1000, token: 'b' }), true);
  assert.equal(bridgeDiscoveryChanged(current, null), false);
  assert.equal(bridgeDiscoveryChanged(null, { port: 1000, token: 'a' }), true);
});
