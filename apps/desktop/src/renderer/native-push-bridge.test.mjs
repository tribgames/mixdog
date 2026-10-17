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

test('an approval whose call is cut off by the reconnect is sent again, and an answer ends the retries', async () => {
  const queue = [{ action: 'allow', sessionId: 's1', approvalId: 'a1' }];
  const native = nativeWith({ takePendingAction: () => queue.shift() ?? null });
  let calls = 0;
  let answered;
  const done = new Promise((resolve) => (answered = resolve));
  const api = {
    resolveToolApprovalForSession: async () => {
      calls += 1;
      if (calls < 3) throw new Error('Remote connection interrupted.');
      answered();
      return false; // already settled / stale: an answer, not a failure
    },
  };
  assert.equal(await drainNativeNotificationActions({ native, api, retryDelayMs: 1 }), 1);
  await done;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 3);
  assert.equal(await drainNativeNotificationActions({ native, api, retryDelayMs: 1 }), 0);
});

const parkedShell = (items) => ({
  platform: 'android',
  version: '1.0.0',
  call: async (method, args) => {
    if (method === 'peekPendingActions') {
      return items.filter((a) => !a.hostId || a.hostId === args.hostId);
    }
    if (method === 'ackPendingAction') {
      const at = items.findIndex((a) => a.id === args.id);
      if (at >= 0) items.splice(at, 1);
      return true;
    }
    throw new Error(`unexpected ${method}`);
  },
});

test('only the connected host takes its actions; other hosts stay parked, and ack follows the answer', async () => {
  const items = [
    { id: 'h-a1', action: 'allow', sessionId: 's1', approvalId: 'a1', hostId: 'hostA' },
    { id: 'h-b1', action: 'deny', sessionId: 's2', approvalId: 'a2', hostId: 'hostB' },
    { id: 'h-open', action: 'open', sessionId: 's3', hostId: 'hostA' },
  ];
  const native = parkedShell(items);
  const resolved = [];
  const api = {
    resolveToolApprovalForSession: async (sessionId, id, decision) => {
      resolved.push([sessionId, id, decision]);
      return false; // wrong/stale answer is still an answer
    },
  };
  assert.equal(await drainNativeNotificationActions({ native, api, hostId: 'hostA' }), 2);
  await until(() => items.length === 1);
  assert.deepEqual(resolved, [['s1', 'a1', { approved: true }]]);
  assert.deepEqual(
    items.map((a) => a.id),
    ['h-b1']
  );
});

test('an approval nobody answered stays parked and is retried by the next drain', async () => {
  const items = [{ id: 'unanswered-1', action: 'allow', sessionId: 's1', approvalId: 'a1', hostId: 'hostA' }];
  const native = parkedShell(items);
  let fail = true;
  let calls = 0;
  const api = {
    resolveToolApprovalForSession: async () => {
      calls += 1;
      if (fail) throw new Error('Remote connection interrupted.');
      return true;
    },
  };
  await drainNativeNotificationActions({ native, api, hostId: 'hostA', retryDelayMs: 1 });
  await until(() => calls === 4);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(items.length, 1);
  fail = false;
  await drainNativeNotificationActions({ native, api, hostId: 'hostA', retryDelayMs: 1 });
  await until(() => items.length === 0);
  assert.equal(calls, 5);
});

test('the shim host reports the connected device id for action matching', () => {
  const host = createNativePushHost({ peerNativePush: true, call: async () => {}, deviceId: 'dev-1' });
  assert.equal(host.hostId(), 'dev-1');
});

test('a denied permission is published for Settings and re-read when the app returns', async () => {
  const { nativePushPermission, subscribeNativePushPermission } = await import('./native-push-bridge.ts');
  let state = { ...granted, permission: 'denied' };
  const native = nativeWith({ getPushState: () => state });
  const on = hostWith(true);
  await syncNativePush({ native: nativeWith({ getPushState: () => granted }), host: on.host });
  on.registered.length = 0;
  let changes = 0;
  const stop = subscribeNativePushPermission(() => {
    changes += 1;
  });
  assert.equal(await syncNativePush({ native, host: on.host }), 'denied');
  assert.equal(nativePushPermission(), 'denied');
  // Even a host that cannot use native push does not hide what the OS says.
  assert.equal(await syncNativePush({ native, host: hostWith(false).host }), 'no-host-support');
  // The user allowed it in system settings and came back: registration resumes.
  state = granted;
  assert.equal(await syncNativePush({ native, host: on.host }), 'registered');
  assert.equal(nativePushPermission(), 'granted');
  assert.equal(on.registered.length, 1);
  assert.equal(changes, 2);
  stop();
});

test("the settings button asks the shell to open this app's notification settings", async () => {
  const { openNativeNotificationSettings } = await import('./native-push-bridge.ts');
  const calls = [];
  const native = (answer) => ({
    platform: 'android',
    version: '1',
    call: async (method) => {
      calls.push(method);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  assert.equal(await openNativeNotificationSettings({ native: native(true) }), true);
  assert.deepEqual(calls, ['openNotificationSettings']);
  // The system could not open it, an older shell answered null, or the bridge failed.
  assert.equal(await openNativeNotificationSettings({ native: native(false) }), false);
  assert.equal(await openNativeNotificationSettings({ native: native(null) }), false);
  assert.equal(await openNativeNotificationSettings({ native: native(new Error('timeout')) }), false);
  assert.equal(await openNativeNotificationSettings({ native: null }), false);
});
