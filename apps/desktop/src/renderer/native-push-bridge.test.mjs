import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNativePushHost,
  drainNativeNotificationActions,
  subscribeNativeNotificationActions,
  syncNativePush,
} from './native-push-bridge.ts';
import { publishedCeilings, until, withShim } from './remote-shim-test-harness.mjs';

const granted = { platform: 'fcm', token: 'tok-1', publicKey: 'pub-1', permission: 'granted' };

const nativeWith = (handlers) => ({
  platform: 'android',
  version: '1.0.0',
  call: async (method) => handlers[method](),
});

const hostWith = (available) => {
  const registered = [];
  return {
    registered,
    host: {
      available: () => available,
      register: async (input) => {
        registered.push(input);
      },
    },
  };
};

test('registers the token only when the host advertises nativePush', async () => {
  const native = nativeWith({ getPushState: () => granted });
  const off = hostWith(false);
  assert.equal(await syncNativePush({ native, host: off.host }), 'no-host-support');
  assert.deepEqual(off.registered, []);
  const on = hostWith(true);
  assert.equal(await syncNativePush({ native, host: on.host }), 'registered');
  assert.deepEqual(on.registered, [{ platform: 'fcm', token: 'tok-1', publicKey: 'pub-1' }]);
});

test('a development iOS build registers as sandbox', async () => {
  const native = nativeWith({ getPushState: () => ({ ...granted, platform: 'apns', sandbox: true }) });
  const on = hostWith(true);
  assert.equal(await syncNativePush({ native, host: on.host }), 'registered');
  assert.deepEqual(on.registered, [{ platform: 'apns', token: 'tok-1', publicKey: 'pub-1', sandbox: true }]);
});

test('asks for permission once and skips until a token exists', async () => {
  let asked = 0;
  const native = nativeWith({
    getPushState: () => ({ ...granted, token: '', permission: 'prompt' }),
    requestPush: () => {
      asked += 1;
      return { ...granted, token: '', permission: 'granted' };
    },
  });
  const on = hostWith(true);
  assert.equal(await syncNativePush({ native, host: on.host }), 'no-token');
  assert.equal(asked, 1);
  assert.deepEqual(on.registered, []);
  const denied = nativeWith({ getPushState: () => ({ ...granted, permission: 'denied' }) });
  assert.equal(await syncNativePush({ native: denied, host: on.host }), 'denied');
  assert.equal(await syncNativePush({ native: null, host: on.host }), 'no-native');
});

test('a plain browser (no native bridge) never registers', async () => {
  const on = hostWith(true);
  assert.equal(await syncNativePush({ native: { platform: 'ios', version: '1' }, host: on.host }), 'no-native');
});

test('the shim host reads the live capability flag and calls registerNativePush', async () => {
  await withShim({}, async (shim) => {
    const host = createNativePushHost(shim.ctx);
    assert.equal(host.available(), false);
    const leg = await shim.dial({ nativePush: true, ready: publishedCeilings(4096, 4096) });
    await until(() => shim.ctx.peerNativePush === true);
    assert.equal(host.available(), true);
    assert.ok(leg);
    shim.ctx.connectionReady = false;
    shim.ctx.socket = null;
    shim.ctx.openPromise = null;
    await shim.dial({ nativePush: false, ready: publishedCeilings(4096, 4096) });
    await until(() => shim.ctx.peerNativePush === false);
    assert.equal(host.available(), false);
  });
});

test('registerNativePush sends exactly the contract fields', async () => {
  const calls = [];
  const host = createNativePushHost({
    peerNativePush: true,
    call: async (method, params) => {
      calls.push([method, params]);
    },
  });
  await host.register({ platform: 'apns', token: 't', publicKey: 'k', extra: 'x' });
  await host.register({ platform: 'apns', token: 't', publicKey: 'k', sandbox: true });
  assert.deepEqual(calls, [
    ['registerNativePush', [{ platform: 'apns', token: 't', publicKey: 'k' }]],
    ['registerNativePush', [{ platform: 'apns', token: 't', publicKey: 'k', sandbox: true }]],
  ]);
});

test('parked actions are delivered once, approvals resolve through the web API', async () => {
  const queue = [
    { action: 'allow', sessionId: 's1', approvalId: 'a1' },
    { action: 'deny', sessionId: 's2', approvalId: 'a2' },
    { action: 'open', sessionId: 's3' },
  ];
  const native = nativeWith({ takePendingAction: () => queue.shift() ?? null });
  const resolved = [];
  const api = {
    resolveToolApprovalForSession: async (sessionId, id, decision) => {
      resolved.push([sessionId, id, decision]);
      return true;
    },
  };
  // Published before anyone subscribes: held for the React subscriber.
  assert.equal(await drainNativeNotificationActions({ native, api }), 3);
  assert.deepEqual(resolved, [
    ['s1', 'a1', { approved: true }],
    ['s2', 'a2', { approved: false }],
  ]);
  const opened = [];
  const stop = subscribeNativeNotificationActions((action) => opened.push(action.sessionId));
  assert.deepEqual(opened, ['s1', 's2', 's3']);
  stop();
  const later = [];
  const stopLater = subscribeNativeNotificationActions((action) => later.push(action.sessionId));
  assert.deepEqual(later, []);
  stopLater();
});
