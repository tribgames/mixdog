import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityBlockedRemotely, friendlyCapabilityError } from './remote-capability-guard.ts';
import { setRemoteHostOpenAccess } from '../remote-host-access.ts';

test('blocked capabilities are flagged only on a remote surface', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    globalThis.window = { dispatchEvent() {} };
    assert.equal(capabilityBlockedRemotely('saveMcpServer'), false);
    globalThis.window = { mixdogRemoteServer: 'https://relay.test', dispatchEvent() {} };
    assert.equal(capabilityBlockedRemotely('saveMcpServer'), true, 'an older host still refuses it');
    assert.equal(capabilityBlockedRemotely('getSnapshot'), false);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  }
});

test('a host announcing open access unblocks everything but the media resolver', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    globalThis.window = { mixdogRemoteServer: 'https://relay.test', dispatchEvent() {} };
    setRemoteHostOpenAccess(true);
    assert.equal(capabilityBlockedRemotely('saveMcpServer'), false);
    assert.equal(capabilityBlockedRemotely('saveProviderApiKey'), false);
    assert.equal(capabilityBlockedRemotely('loginOAuthProvider'), false);
    assert.equal(capabilityBlockedRemotely('resolveMediaFile'), true);
    setRemoteHostOpenAccess(false);
    assert.equal(capabilityBlockedRemotely('saveMcpServer'), true);
  } finally {
    setRemoteHostOpenAccess(false);
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  }
});

test('the raw remote-access rejection becomes a friendly message', () => {
  const raw = new TypeError('capability saveMcpServer is not available over remote access.');
  const friendly = friendlyCapabilityError(raw);
  assert.ok(friendly instanceof Error);
  assert.doesNotMatch(friendly.message, /capability/);
  const other = new Error('boom');
  assert.equal(friendlyCapabilityError(other), other);
});
