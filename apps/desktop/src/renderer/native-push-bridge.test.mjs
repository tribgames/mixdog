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

/** The host's notification answer (remote-session-methods answerApprovalNotification). */
const answering = (answer) => {
  const answered = [];
  return {
    answered,
    host: {
      available: () => true,
      register: async () => {},
      answerApproval: async (sessionId, id, action) => {
        answered.push([sessionId, id, action]);
        return typeof answer === 'function' ? answer() : answer;
      },
    },
  };
};

test('parked actions are delivered once, approvals answer through the host’s notification method', async () => {
  const queue = [
    { action: 'allow', sessionId: 's1', approvalId: 'a1' },
    { action: 'deny', sessionId: 's2', approvalId: 'a2' },
    { action: 'open', sessionId: 's3' },
  ];
  const native = nativeWith({ takePendingAction: () => queue.shift() ?? null });
  const { host, answered } = answering('answered');
  // Published before anyone subscribes: held for the React subscriber.
  assert.equal(await drainNativeNotificationActions({ native, host }), 3);
  assert.deepEqual(answered, [
    ['s1', 'a1', 'allow'],
    ['s2', 'a2', 'deny'],
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
  const { host } = answering(() => {
    calls += 1;
    if (calls < 3) throw new Error('Remote connection interrupted.');
    answered();
    return 'settled'; // already settled / stale: an answer, not a failure
  });
  assert.equal(await drainNativeNotificationActions({ native, host, retryDelayMs: 1 }), 1);
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  assert.equal(await drainNativeNotificationActions({ native, host, retryDelayMs: 1 }), 0);
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
  // A wrong or stale approval is still an answer.
  const { host, answered } = answering('settled');
  assert.equal(await drainNativeNotificationActions({ native, host, hostId: 'hostA' }), 2);
  await until(() => items.length === 1);
  assert.deepEqual(answered, [['s1', 'a1', 'allow']]);
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
  const { host } = answering(() => {
    calls += 1;
    if (fail) throw new Error('Remote connection interrupted.');
    return 'answered';
  });
  await drainNativeNotificationActions({ native, host, hostId: 'hostA', retryDelayMs: 1 });
  await until(() => calls === 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(items.length, 1);
  fail = false;
  await drainNativeNotificationActions({ native, host, hostId: 'hostA', retryDelayMs: 1 });
  await until(() => items.length === 0);
  assert.equal(calls, 5);
});

test('an Allow the host answers "open" is acknowledged once and its session opened, never retried', async () => {
  const items = [{ id: 'pay-1', action: 'allow', sessionId: 's9', approvalId: 'p1', hostId: 'hostA' }];
  const native = parkedShell(items);
  const { host, answered } = answering('open');
  const opened = [];
  const stop = subscribeNativeNotificationActions((action) => opened.push(action.sessionId));
  // What earlier drains published with nobody listening.
  opened.length = 0;
  try {
    await drainNativeNotificationActions({ native, host, hostId: 'hostA', retryDelayMs: 1 });
    await until(() => items.length === 0);
    assert.deepEqual(answered, [['s9', 'p1', 'allow']]);
    assert.deepEqual(opened, ['s9'], 'the app opens on the approval, to be decided there');
  } finally {
    stop();
  }
});

test('the shim host sends a notification answer as answerApprovalNotification', async () => {
  const calls = [];
  const host = createNativePushHost({
    peerNativePush: true,
    call: async (method, params) => {
      calls.push([method, params]);
      return 'answered';
    },
  });
  assert.equal(await host.answerApproval('s1', 'a1', 'allow'), 'answered');
  assert.deepEqual(calls, [['answerApprovalNotification', ['s1', 'a1', 'allow']]]);
});

test('the shell is handed the approval action labels to show', async () => {
  const { publishNativeNotificationLabels } = await import('./native-push-bridge.ts');
  const calls = [];
  const native = {
    platform: 'android',
    version: '1',
    call: async (method, args) => {
      calls.push([method, args]);
      return true;
    },
  };
  assert.equal(await publishNativeNotificationLabels({ deny: '거절', allowOnce: '한 번만 허용' }, { native }), true);
  assert.deepEqual(calls, [['setNotificationLabels', { deny: '거절', allowOnce: '한 번만 허용' }]]);
  // A plain browser, or an older shell that does not know the call.
  const english = { deny: 'Deny', allowOnce: 'Allow just once' };
  assert.equal(await publishNativeNotificationLabels(english, { native: null }), false);
  const older = { ...native, call: async () => null };
  assert.equal(await publishNativeNotificationLabels(english, { native: older }), false);
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
