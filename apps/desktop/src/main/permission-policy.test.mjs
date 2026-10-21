import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopPermissionAllowed } from './permission-policy.ts';

test('the trusted desktop renderer can copy text, use camera/microphone and enter fullscreen', () => {
  const renderer = {};
  for (const permission of ['clipboard-sanitized-write', 'media', 'fullscreen']) {
    assert.equal(desktopPermissionAllowed(permission, renderer, renderer), true, permission);
  }
});

test('clipboard reads and unrelated permissions remain denied in the desktop renderer', () => {
  const renderer = {};
  for (const permission of [
    'clipboard-read',
    'deprecated-sync-clipboard-read',
    'geolocation',
    'notifications',
    'openExternal',
    'display-capture',
    'fileSystem',
    'unknown',
  ]) {
    assert.equal(desktopPermissionAllowed(permission, renderer, renderer), false, permission);
  }
});

test('other pages and missing senders cannot obtain desktop copy, media or fullscreen permissions', () => {
  const renderer = {};
  for (const permission of ['clipboard-sanitized-write', 'media', 'fullscreen']) {
    for (const sender of [{}, null, undefined]) {
      assert.equal(desktopPermissionAllowed(permission, sender, renderer), false, permission);
    }
    for (const missing of [null, undefined]) {
      assert.equal(desktopPermissionAllowed(permission, renderer, missing), false, permission);
      assert.equal(desktopPermissionAllowed(permission, missing, missing), false, permission);
    }
  }
});
