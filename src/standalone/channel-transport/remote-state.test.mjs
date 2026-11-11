import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteStatePublisher } from './remote-state.mjs';

test('an acquired remote state with no pinned session is published as disabled, never for the session "null"', () => {
  const states = [];
  const state = { clients: new Map(), pointerToken: null, remoteAcquired: true, pinnedSessionId: null, remoteIntent: null };
  createRemoteStatePublisher({ state, log() {}, remoteStatePath: null, onRemoteStateChange: (published) => states.push(published) })();
  assert.equal(states.length, 1);
  assert.equal(states[0].enabled, false);
  assert.equal(states[0].sessionId, null);
});

test('a pinned session is still published as enabled for that session', () => {
  const states = [];
  const state = { clients: new Map(), pointerToken: null, remoteAcquired: true, pinnedSessionId: 'session_remote', remoteIntent: null };
  createRemoteStatePublisher({ state, log() {}, remoteStatePath: null, onRemoteStateChange: (published) => states.push(published) })();
  assert.equal(states[0].enabled, true);
  assert.equal(states[0].sessionId, 'session_remote');
});