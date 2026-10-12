import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteCapabilityBlocked } from './remote-blocked-capabilities.ts';

test('only host-internal capabilities are blocked for every client', () => {
  assert.equal(remoteCapabilityBlocked('resolveMediaFile'), true);
  assert.equal(remoteCapabilityBlocked('saveProviderApiKey'), false);
  assert.equal(remoteCapabilityBlocked('getSnapshot'), false);
});
