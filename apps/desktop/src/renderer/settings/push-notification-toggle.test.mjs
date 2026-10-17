import assert from 'node:assert/strict';
import test from 'node:test';

import { PushEnableError } from '../push-notification-bridge';
import { pushEnableFailureNote, pushSupported, pushUnavailableReason } from './push-notification-toggle';

function withBrowser(t, browser, nav) {
  const saved = ['window', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
}

test('an unsupported retryable failure is a generic note, not "no push service"', () => {
  assert.equal(pushEnableFailureNote(new PushEnableError('failed')), 'Could not turn notifications on. Try again.');
});

test('iOS Safari outside a Home Screen install is told to install; the other surfaces are unchanged', (t) => {
  const api = { pushPublicKey: async () => 'key' };
  // iOS Safari tab: no Notification/PushManager, and `standalone` exists as false.
  withBrowser(t, { isSecureContext: true }, { serviceWorker: {}, standalone: false });
  assert.equal(pushSupported(api), false);
  assert.equal(pushUnavailableReason(api), 'install');
  // The installed Home Screen app has Web Push: the switch is offered.
  withBrowser(t, { isSecureContext: true, Notification: {}, PushManager: {} }, { serviceWorker: {}, standalone: true });
  assert.equal(pushSupported(api), true);
  assert.equal(pushUnavailableReason(api), null);
  // A browser lacking push without the iOS property stays hidden, as before.
  withBrowser(t, { isSecureContext: true }, { serviceWorker: {} });
  assert.equal(pushUnavailableReason(api), null);
  // Plain http cannot do Web Push at all.
  withBrowser(t, { isSecureContext: false }, { serviceWorker: {} });
  assert.equal(pushUnavailableReason(api), 'secure');
  // The phone app's shell (a WebView, also `standalone: false`) owns its notifications.
  withBrowser(t, { isSecureContext: true, mixdogNative: { platform: 'ios', call() {} } }, { standalone: false });
  assert.equal(pushUnavailableReason(api), null);
  // The desktop window has no pushPublicKey: no switch, no note.
  withBrowser(t, { isSecureContext: true }, { serviceWorker: {}, standalone: false });
  assert.equal(pushUnavailableReason({}), null);
});

test('a failed turn-on names what failed instead of always blaming the connection', () => {
  assert.match(pushEnableFailureNote(new PushEnableError('push-service')), /no push service/u);
  assert.match(pushEnableFailureNote(new PushEnableError('blocked')), /site settings/u);
  assert.match(pushEnableFailureNote(new PushEnableError('outdated')), /^Update Mixdog on this PC/u);
  assert.match(pushEnableFailureNote(new PushEnableError('unreachable')), /Check the connection to your desktop/u);
  assert.equal(pushEnableFailureNote(new Error('boom')), 'Could not turn notifications on. Try again.');
});

test('the switch is offered in a browser with Web Push, never in the Electron remote window', (t) => {
  const saved = ['window', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const browser = { isSecureContext: true, Notification: {}, PushManager: {} };
  define('window', browser);
  define('navigator', { serviceWorker: {} });
  const api = { pushPublicKey: async () => 'key' };
  assert.equal(pushSupported(api), true);
  // "Connect to another PC" runs the same shim in Electron, which has no push
  // service: subscribe() could only ever fail there.
  browser.mixdogRemoteWindow = { hostId: 'a', hostName: 'Home PC' };
  assert.equal(pushSupported(api), false);
});
