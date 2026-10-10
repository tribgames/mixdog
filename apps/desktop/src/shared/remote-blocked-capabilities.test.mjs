import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_BLOCKED_CAPABILITIES } from '../main/remote-methods.ts';
import { REMOTE_BLOCKED_CAPABILITY_NAMES, remoteCapabilityBlocked } from './remote-blocked-capabilities.ts';

test('only host-internal capabilities are blocked for every client', () => {
  assert.equal(remoteCapabilityBlocked('resolveMediaFile'), true);
  assert.equal(remoteCapabilityBlocked('saveProviderApiKey'), false);
  assert.equal(remoteCapabilityBlocked('getSnapshot'), false);
});

test('the renderer capability list mirrors the host deny list', () => {
  assert.deepEqual([...REMOTE_BLOCKED_CAPABILITY_NAMES].sort(), [...REMOTE_BLOCKED_CAPABILITIES].sort());
});
