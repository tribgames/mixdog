import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_STATE_CACHE_NAME,
  NOTIFICATION_CLICK_ENTRY,
  NOTIFICATION_CLICK_TTL_MS,
  UI_LANGUAGE_ENTRY,
  claimNotificationClick,
  clearNotificationClick,
  installPushSubscriptionSync,
  publishUiLanguage,
  routeNotificationTap,
  PUSH_RESTATE_INTERVAL_MS,
  PUSH_SUBSCRIPTION_CHANGED_MESSAGE,
  PushEnableError,
  PushServerCleanupError,
  removePushSubscription,
  statePushSubscription,
  syncPushSubscription,
  unregisterRelayPushSubscription,
} from './push-notification-bridge';
import { remotePairingKeys } from './remote-pairing-recovery';
import { generateRelayE2EEServerIdentity, openRelayWebPushKeys, relayE2EEPairingMaterial } from '../shared/remote-e2ee';
import { WORKER_ORIGIN, loadWorker, memoryCacheStorage } from './sw-test-harness.mjs';
import { SUPPORTED_UI_LANGUAGES } from '../shared/ui-language';

/** Drive the worker's real listeners, as a device would. */
function tap(worker, sessionId, hostId) {
  let settled;
  worker.listeners.get('notificationclick')({
    notification: { close() {}, data: hostId === undefined ? { sessionId } : { sessionId, hostId } },
    waitUntil: (promise) => {
      settled = promise;
    },
  });
  return settled;
}

function push(worker, payload) {
  let settled;
  worker.listeners.get('push')({
    data: { json: () => payload },
    waitUntil: (promise) => {
      settled = promise;
    },
  });
  return settled;
}

async function launchFrom(worker, path) {
  let responded;
  let settled;
  worker.listeners.get('fetch')({
    request: { url: `${WORKER_ORIGIN}${path}`, mode: 'navigate', method: 'GET' },
    respondWith: (promise) => {
      responded = promise;
    },
    waitUntil: (promise) => {
      settled = promise;
    },
  });
  await responded;
  await settled;
}

test('the worker and the app name the same shared state', () => {
  const worker = loadWorker({ caches: memoryCacheStorage() });

  assert.equal(worker.APP_STATE_CACHE, APP_STATE_CACHE_NAME);
  assert.equal(worker.UI_LANGUAGE_ENTRY, UI_LANGUAGE_ENTRY);
  assert.equal(worker.NOTIFICATION_CLICK_ENTRY, NOTIFICATION_CLICK_ENTRY);
  assert.equal(worker.NOTIFICATION_CLICK_TTL_MS, NOTIFICATION_CLICK_TTL_MS);
});

test('a tap with nothing running opens the route the app was installed at', async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  // The install lives under a device route; the bare origin is a different
  // container that would only reach the pairing gate.
  await launchFrom(worker, '/d/9f8e7d6c5b4a/');
  await tap(worker, 'session-42');

  assert.deepEqual(worker.opened, ['/d/9f8e7d6c5b4a/?session=session-42']);
});

test('a plain install still opens the origin', async () => {
  const worker = loadWorker({ caches: memoryCacheStorage() });
  await launchFrom(worker, '/');
  await tap(worker, 'session-42');

  assert.deepEqual(worker.opened, ['/?session=session-42']);
});

test('a running app is focused and told directly', async () => {
  const posted = [];
  let focused = 0;
  const worker = loadWorker({
    caches: memoryCacheStorage(),
    windows: [
      {
        url: `${WORKER_ORIGIN}/d/9f8e7d6c5b4a/`,
        focus: async () => {
          focused += 1;
        },
        postMessage: (message) => posted.push(message),
      },
    ],
  });
  await tap(worker, 'session-42');

  assert.equal(focused, 1);
  assert.deepEqual(
    posted.map((message) => message.sessionId),
    ['session-42']
  );
  assert.deepEqual(worker.opened, []);
});

test('a tap survives a phone that rebuilt the app around it', async () => {
  const caches = memoryCacheStorage();
  // The window is focused and posted to, but that document was discarded and
  // is still booting: nothing is listening yet.
  const worker = loadWorker({
    caches,
    windows: [
      {
        url: `${WORKER_ORIGIN}/d/9f8e7d6c5b4a/`,
        focus: async () => undefined,
        postMessage: () => undefined,
      },
    ],
  });
  await tap(worker, 'session-42');

  assert.deepEqual(await claimNotificationClick({ caches }), { sessionId: 'session-42', hostId: '' });
  // One tap, one navigation.
  assert.equal(await claimNotificationClick({ caches }), null);
});

test('a tap the app already handled is retired', async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  await tap(worker, 'session-42');
  await clearNotificationClick({ caches });

  assert.equal(await claimNotificationClick({ caches }), null);
});

test('a stale tap opens nothing', async () => {
  const caches = memoryCacheStorage();
  const worker = loadWorker({ caches });
  await tap(worker, 'session-42');

  assert.equal(await claimNotificationClick({ caches, now: Date.now() + NOTIFICATION_CLICK_TTL_MS + 1 }), null);
});

test('a turn with no text speaks the language the app published', async () => {
  const caches = memoryCacheStorage();
  await publishUiLanguage('ko', { caches });
  const worker = loadWorker({ caches, systemLanguage: 'en-US' });
  await push(worker, { title: 'Refactor', body: '', data: { sessionId: 'session-42' } });

  assert.equal(worker.shown[0].options.body, '작업을 마쳤습니다.');
});

test('a phone that never launched the app falls back to its own language', async () => {
  const worker = loadWorker({ caches: memoryCacheStorage(), systemLanguage: 'ja-JP' });
  await push(worker, { title: 'Refactor', body: '', data: { sessionId: 'session-42' } });

  assert.equal(worker.shown[0].options.body, '作業が完了しました。');
});

test('what the session actually said is never translated', async () => {
  const caches = memoryCacheStorage();
  await publishUiLanguage('ko', { caches });
  const worker = loadWorker({ caches, systemLanguage: 'ko-KR' });
  await push(worker, { title: 'Refactor', body: 'Applied 3 edits.', data: { sessionId: 's' } });

  assert.equal(worker.shown[0].options.body, 'Applied 3 edits.');
});

test('push fallback uses each supported preference and ignores invalid preferences', async () => {
  for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
    const caches = memoryCacheStorage();
    await publishUiLanguage(language, { caches });
    const worker = loadWorker({ caches, systemLanguage: 'ko-KR' });
    await push(worker, { title: 'History', body: '', data: { sessionId: 'session-i18n' } });
    assert.equal(worker.shown[0].title, 'History');
    assert.ok(worker.shown[0].options.body);
    if (language === 'en') assert.equal(worker.shown[0].options.body, 'Finished working.');
    else assert.notEqual(worker.shown[0].options.body, 'Finished working.', language);
  }
  const caches = memoryCacheStorage();
  await publishUiLanguage('invalid', { caches });
  const worker = loadWorker({ caches, systemLanguage: 'ja-JP' });
  await push(worker, { title: 'History', body: '', data: { sessionId: 'session-i18n' } });
  assert.equal(worker.shown[0].options.body, '作業が完了しました。');
});

let clock = 1_000_000;

/** The page's service worker channel: `send` delivers a worker message. */
function workerMessages() {
  const handlers = new Set();
  return {
    addEventListener: (_name, handler) => handlers.add(handler),
    removeEventListener: (_name, handler) => handlers.delete(handler),
    send: (data) => {
      for (const handler of [...handlers]) handler({ data });
    },
    handlers,
  };
}

test('the push subscription is restated on each connection until the desktop accepted it once', async () => {
  const saved = ['Notification', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('Notification', { permission: 'granted' });
  define('navigator', {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => ({
            endpoint: 'https://push.example/1',
            toJSON: () => ({ keys: { p256dh: 'k', auth: 'a' } }),
          }),
        },
      }),
    },
  });
  try {
    const listeners = new Set();
    const target = {
      addEventListener: (_name, listener) => listeners.add(listener),
      removeEventListener: (_name, listener) => listeners.delete(listener),
    };
    let calls = 0;
    const api = {
      registerPushSubscription: async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection interrupted');
      },
    };
    // A relay that predates relay-owned push: the legacy per-PC registration.
    installPushSubscriptionSync(
      api,
      'ready',
      target,
      { fetch: async () => new Response('', { status: 404 }), now: () => clock },
      workerMessages()
    );
    const fire = async () => {
      for (const listener of [...listeners]) listener();
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await fire(); // dropped under the call
    assert.equal(calls, 1);
    await fire(); // the next connection delivers it
    assert.equal(calls, 2);
    await fire(); // a flapping connection right after: nothing new to say
    assert.equal(calls, 2, 'accepted: connections this close are left alone');
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

// ---- several PCs, one subscription ------------------------------------------

const PC_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PC_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PC_GONE = 'cccccccc-3333-4333-8333-cccccccccccc';

test('the worker keeps the sending PC through the notification, its tap and its launch', async () => {
  const caches = memoryCacheStorage();
  const posted = [];
  const running = loadWorker({
    caches,
    windows: [{ url: `${WORKER_ORIGIN}/d/${PC_A}/`, focus: async () => undefined, postMessage: (m) => posted.push(m) }],
  });
  await push(running, {
    hostId: PC_B,
    sessionId: 's-1',
    title: 'B',
    body: 'done',
    data: { sessionId: 's-1', hostId: PC_B },
  });
  const shown = running.shown[0].options;
  assert.equal(shown.data.hostId, PC_B);
  // Two PCs can both have an `s-1`: the PC is part of the notification's identity.
  assert.equal(shown.tag, `session:${PC_B}:s-1`);
  await push(running, { title: 'A', body: 'x', data: { sessionId: 's-1', hostId: PC_A.toUpperCase() } });
  assert.notEqual(running.shown[1].options.tag, shown.tag);
  await push(running, { title: 'bad', body: 'x', data: { sessionId: 's-1', hostId: '../../evil' } });
  assert.equal(running.shown[2].options.data.hostId, '');

  await tap(running, 's-1', PC_B);
  assert.deepEqual(
    posted.map(({ sessionId, hostId }) => ({ sessionId, hostId })),
    [{ sessionId: 's-1', hostId: PC_B }]
  );
  assert.deepEqual(await claimNotificationClick({ caches }), { sessionId: 's-1', hostId: PC_B });

  // Nothing running: the installed scope opens and is told which PC sent it.
  const cold = loadWorker({ caches: memoryCacheStorage() });
  await launchFrom(cold, `/d/${PC_A}/`);
  await tap(cold, 's-1', PC_B);
  assert.deepEqual(cold.opened, [`/d/${PC_A}/?session=s-1&host=${PC_B}`]);
});

/** localStorage holding this browser's pairing with each PC, as the shim
 *  stores it (remote-pairing-recovery.ts remotePairingKeys). */
function pairedStorage(origin, pcs) {
  const values = new Map();
  for (const { deviceId, token, pairing } of pcs) {
    const keys = remotePairingKeys(origin, deviceId);
    values.set(keys.token, token);
    values.set(keys.e2eePublicKey, pairing.serverPublicKey);
    values.set(keys.e2eeSecret, pairing.pairingSecret);
  }
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('only the PC this page drives opens a tap here; another paired PC is switched to', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const origin = 'https://relay.mixdog.test';
  const environment = {
    origin,
    currentHostId: PC_A,
    hostIds: [PC_B, PC_GONE],
    storage: pairedStorage(origin, [
      { deviceId: PC_A, token: 'a'.repeat(64), pairing: relayE2EEPairingMaterial(identity) },
      { deviceId: PC_B, token: 'b'.repeat(64), pairing: relayE2EEPairingMaterial(identity) },
    ]),
  };
  assert.deepEqual(routeNotificationTap({ sessionId: 's', hostId: PC_A }, environment), {
    action: 'open',
    sessionId: 's',
  });
  assert.deepEqual(routeNotificationTap({ sessionId: 's', hostId: PC_B }, environment), {
    action: 'switch',
    url: `/d/${PC_B}/?session=s&host=${PC_B}`,
  });
  // Saved but no longer paired here, or never known: never opened on PC A.
  assert.deepEqual(routeNotificationTap({ sessionId: 's', hostId: PC_GONE }, environment), { action: 'ignore' });
  assert.deepEqual(
    routeNotificationTap({ sessionId: 's', hostId: 'dddddddd-4444-4444-8444-dddddddddddd' }, environment),
    { action: 'ignore' }
  );
  // A PC that predates host ids only ever reached this page through its own PC.
  assert.deepEqual(routeNotificationTap({ sessionId: 's', hostId: '' }, environment), {
    action: 'open',
    sessionId: 's',
  });
});

async function withPushGlobals(pushManager, run) {
  const saved = ['Notification', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('Notification', { permission: 'granted' });
  define('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
  try {
    return await run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function fakeSubscription(endpoint, serverKey) {
  const p256dh = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 7)]).toString('base64url');
  return {
    endpoint,
    unsubscribed: false,
    options: { applicationServerKey: serverKey ? new Uint8Array(Buffer.from(serverKey, 'base64url')).buffer : null },
    toJSON: () => ({ endpoint, keys: { p256dh, auth: Buffer.alloc(16, 9).toString('base64url') } }),
    async unsubscribe() {
      this.unsubscribed = true;
      return true;
    },
  };
}

test('a subscription made with a PC key is migrated to the relay key and registered with every paired PC', async () => {
  const relayKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 1)]).toString('base64url');
  const pcKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 2)]).toString('base64url');
  const identityA = await generateRelayE2EEServerIdentity();
  const identityB = await generateRelayE2EEServerIdentity();
  const origin = 'https://relay.mixdog.test';
  const storage = pairedStorage(origin, [
    { deviceId: PC_A, token: 'a'.repeat(64), pairing: relayE2EEPairingMaterial(identityA) },
    { deviceId: PC_B, token: 'b'.repeat(64), pairing: relayE2EEPairingMaterial(identityB) },
  ]);
  const legacy = fakeSubscription('https://push.example.com/legacy', pcKey);
  const fresh = fakeSubscription('https://push.example.com/relay', relayKey);
  const subscribed = [];
  let current = legacy;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async (options) => {
      subscribed.push(Buffer.from(options.applicationServerKey).toString('base64url'));
      current = fresh;
      return fresh;
    },
  };
  const posts = [];
  const environment = {
    origin,
    storage,
    currentHostId: PC_A,
    hostIds: [PC_B],
    fetch: async (url, init = {}) => {
      if (url === '/webpush/key') return Response.json({ publicKey: relayKey });
      if (url === '/webpush/status') return Response.json({ registered: false, supported: true });
      posts.push({ url, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
      return Response.json({ registered: true });
    },
  };
  const legacyRegistrations = [];
  const api = { registerPushSubscription: async (input) => legacyRegistrations.push(input) };

  assert.equal(await withPushGlobals(pushManager, () => syncPushSubscription(api, environment)), true);
  // The PC-keyed subscription could only ever reach one PC: it is replaced.
  assert.equal(legacy.unsubscribed, true);
  assert.deepEqual(subscribed, [relayKey]);
  assert.deepEqual(legacyRegistrations, [], 'the legacy per-PC RPC is not used');
  // One registration per paired PC, each with that PC's own credential, and
  // each PC's box opens only for that PC.
  posts.sort((left, right) => left.authorization.localeCompare(right.authorization));
  assert.deepEqual(
    posts.map((post) => [post.url, post.authorization, post.body.endpoint]),
    [
      ['/webpush/register', `Bearer ${'a'.repeat(64)}`, fresh.endpoint],
      ['/webpush/register', `Bearer ${'b'.repeat(64)}`, fresh.endpoint],
    ]
  );
  const keysA = await openRelayWebPushKeys(identityA, fresh.endpoint, posts[0].body.sealed);
  assert.deepEqual(keysA, fresh.toJSON().keys);
  assert.equal(await openRelayWebPushKeys(identityB, fresh.endpoint, posts[0].body.sealed), null);
  assert.deepEqual(await openRelayWebPushKeys(identityB, fresh.endpoint, posts[1].body.sealed), keysA);

  // Already on the relay key: kept as it is, only restated — with the very
  // same boxes, so the relay has nothing to write or announce.
  const firstRound = posts.splice(0);
  assert.equal(await withPushGlobals(pushManager, () => syncPushSubscription(api, environment)), true);
  assert.equal(fresh.unsubscribed, false);
  assert.equal(subscribed.length, 1);
  posts.sort((left, right) => left.authorization.localeCompare(right.authorization));
  assert.deepEqual(
    posts.map((post) => post.body),
    firstRound.map((post) => post.body)
  );
});

/** Two paired PCs; `supported` says which deliver through the relay. */
async function mixedPcs(supported) {
  const relayKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 1)]).toString('base64url');
  const pcKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 2)]).toString('base64url');
  const origin = 'https://relay.mixdog.test';
  const storage = pairedStorage(origin, [
    {
      deviceId: PC_A,
      token: 'a'.repeat(64),
      pairing: relayE2EEPairingMaterial(await generateRelayE2EEServerIdentity()),
    },
    {
      deviceId: PC_B,
      token: 'b'.repeat(64),
      pairing: relayE2EEPairingMaterial(await generateRelayE2EEServerIdentity()),
    },
  ]);
  const legacy = fakeSubscription('https://push.example.com/legacy', pcKey);
  const fresh = fakeSubscription('https://push.example.com/relay', relayKey);
  let current = legacy;
  const subscribedWith = [];
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async ({ applicationServerKey }) => {
      const key = Buffer.from(applicationServerKey).toString('base64url');
      subscribedWith.push(key);
      current = key === relayKey ? fresh : fakeSubscription('https://push.example.com/legacy-2', key);
      return current;
    },
  };
  const registered = [];
  const environment = {
    origin,
    storage,
    currentHostId: PC_A,
    hostIds: [PC_B],
    fetch: async (url, init = {}) => {
      if (url === '/webpush/key') return Response.json({ publicKey: relayKey });
      const pc = init.headers.Authorization.endsWith('a'.repeat(64)) ? PC_A : PC_B;
      if (url === '/webpush/status') return Response.json({ registered: false, supported: supported.includes(pc) });
      registered.push(pc);
      return Response.json({ registered: true });
    },
  };
  const legacyRegistrations = [];
  const api = {
    registerPushSubscription: async (input) => legacyRegistrations.push(input.endpoint),
    pushPublicKey: async () => pcKey,
  };
  const useRelayKeyed = () => {
    current = fresh;
  };
  const clear = () => {
    current = null;
  };
  return {
    pushManager,
    environment,
    api,
    legacy,
    fresh,
    registered,
    legacyRegistrations,
    subscribedWith,
    pcKey,
    useRelayKeyed,
    clear,
    current: () => current,
  };
}

test('a relay-keyed subscription with only legacy PCs left is resubscribed with the PC key and registered', async () => {
  const world = await mixedPcs([]);
  world.useRelayKeyed(); // e.g. the only upgraded PC was removed
  const state = await withPushGlobals(world.pushManager, () =>
    statePushSubscription(world.api, world.pushManager, false, world.environment)
  );
  assert.equal(state.mode, 'legacy');
  assert.equal(state.complete, true);
  assert.equal(world.fresh.unsubscribed, true, 'the relay-keyed subscription is dropped');
  assert.deepEqual(world.subscribedWith, [world.pcKey]);
  assert.deepEqual(world.legacyRegistrations, ['https://push.example.com/legacy-2']);
  assert.deepEqual(world.registered, []);
  // Idempotent: restating keeps the PC-keyed subscription as it is.
  const resubscribed = world.current();
  assert.equal(
    await withPushGlobals(world.pushManager, () => syncPushSubscription(world.api, world.environment)),
    true
  );
  assert.equal(resubscribed.unsubscribed, false);
  assert.deepEqual(world.subscribedWith, [world.pcKey]);
});

test('the subscription is registered only with PCs that deliver through the relay', async () => {
  const world = await mixedPcs([PC_A]);
  const state = await withPushGlobals(world.pushManager, () =>
    statePushSubscription(world.api, world.pushManager, false, world.environment)
  );
  assert.equal(state.mode, 'relay');
  assert.equal(state.complete, true);
  // PC B (an older desktop would ignore it) is never registered, and is
  // reported so Settings can say it needs an update.
  assert.deepEqual(world.registered, [PC_A]);
  assert.deepEqual(
    state.hosts.map(({ deviceId, supported, registered }) => [deviceId, supported, registered]),
    [
      [PC_A, true, true],
      [PC_B, false, false],
    ]
  );
});

test('while no paired PC delivers through the relay, the PC-keyed subscription stays on its legacy path', async () => {
  const world = await mixedPcs([]);
  assert.equal(
    await withPushGlobals(world.pushManager, () => syncPushSubscription(world.api, world.environment)),
    true
  );
  assert.equal(world.legacy.unsubscribed, false, 'not migrated: no PC could deliver to the new one');
  assert.deepEqual(world.subscribedWith, []);
  assert.deepEqual(world.registered, []);
  assert.deepEqual(world.legacyRegistrations, [world.legacy.endpoint]);
});

test('a relay that cannot be asked leaves the subscription alone and retries later', async () => {
  const legacy = fakeSubscription('https://push.example.com/legacy', null);
  const pushManager = { getSubscription: async () => legacy, subscribe: async () => assert.fail('no subscribe') };
  const api = { registerPushSubscription: async () => assert.fail('no legacy registration') };
  const ok = await withPushGlobals(pushManager, () =>
    syncPushSubscription(api, { fetch: async () => new Response('', { status: 503 }) })
  );
  assert.equal(ok, false);
  assert.equal(legacy.unsubscribed, false);
});

test('turning notifications on while a paired PC cannot be asked subscribes on the connected PC key', async () => {
  const world = await mixedPcs([]);
  world.clear(); // first enable: no subscription yet
  const answer = world.environment.fetch;
  // PC B's status cannot be had (relay 5xx for it): whether ANY PC delivers
  // through the relay is undecided. Turning on must still give a subscription.
  world.environment.fetch = async (url, init = {}) =>
    url === '/webpush/status' && init.headers.Authorization.endsWith('b'.repeat(64))
      ? new Response('', { status: 503 })
      : answer(url, init);
  const state = await withPushGlobals(world.pushManager, () =>
    statePushSubscription(world.api, world.pushManager, true, world.environment)
  );
  assert.ok(state.subscription, 'turning on yields a subscription');
  assert.equal(state.mode, 'legacy');
  assert.equal(state.complete, false, 'stated again once PC B can be asked');
  assert.deepEqual(world.subscribedWith, [world.pcKey]);
  assert.deepEqual(world.legacyRegistrations, [state.subscription.endpoint]);

  // A subscription that already exists is still left alone while undecided.
  world.useRelayKeyed();
  const kept = await withPushGlobals(world.pushManager, () =>
    statePushSubscription(world.api, world.pushManager, true, world.environment)
  );
  assert.equal(kept.subscription, world.fresh);
  assert.equal(world.fresh.unsubscribed, false);
});

async function enableFailure(api, pushManager, fetch) {
  const error = await withPushGlobals(pushManager, () =>
    statePushSubscription(api, pushManager, true, { fetch, origin: 'https://relay.mixdog.test' }).then(
      () => assert.fail('expected a failure'),
      (failure) => failure
    )
  );
  assert.ok(error instanceof PushEnableError, String(error));
  return error.reason;
}

test('a failed enable names its cause: push service, PC version, PC connection, relay', async () => {
  const pcKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 2)]).toString('base64url');
  const legacyRelay = async () => new Response('', { status: 404 });
  const empty = {
    getSubscription: async () => null,
    subscribe: async () => fakeSubscription('https://push.example.com/x', pcKey),
  };
  const api = { pushPublicKey: async () => pcKey, registerPushSubscription: async () => true };

  // A browser with no push service (an Electron window, a browser with push
  // turned off): subscribe() rejects with AbortError.
  const noService = {
    getSubscription: async () => null,
    subscribe: async () => {
      throw new DOMException('Registration failed - push service not available', 'AbortError');
    },
  };
  assert.equal(await enableFailure(api, noService, legacyRelay), 'push-service');
  const refused = {
    getSubscription: async () => null,
    subscribe: async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    },
  };
  assert.equal(await enableFailure(api, refused, legacyRelay), 'blocked');

  // A PC that predates push answers `unknown method`.
  const outdated = { ...api, pushPublicKey: async () => Promise.reject(new Error('unknown method: pushPublicKey')) };
  assert.equal(await enableFailure(outdated, empty, legacyRelay), 'outdated');
  // A PC that cannot be reached.
  const offline = { ...api, pushPublicKey: async () => Promise.reject(new Error('Relay is not connected.')) };
  assert.equal(await enableFailure(offline, empty, legacyRelay), 'unreachable');
  const unregistered = { ...api, registerPushSubscription: async () => Promise.reject(new Error('timed out')) };
  assert.equal(await enableFailure(unregistered, empty, legacyRelay), 'unreachable');
  // The relay itself cannot be asked.
  assert.equal(await enableFailure(api, empty, async () => new Response('', { status: 503 })), 'unreachable');
});

// ---- review fixes: off, on, renewal, error mapping --------------------------

async function oneRelayPc(status) {
  const relayKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 1)]).toString('base64url');
  const origin = 'https://relay.mixdog.test';
  const storage = pairedStorage(origin, [
    {
      deviceId: PC_A,
      token: 'a'.repeat(64),
      pairing: relayE2EEPairingMaterial(await generateRelayE2EEServerIdentity()),
    },
  ]);
  return {
    relayKey,
    environment: {
      origin,
      storage,
      currentHostId: PC_A,
      hostIds: [],
      fetch: async (url) => {
        if (url === '/webpush/key') return Response.json({ publicKey: relayKey });
        if (url === '/webpush/status') return Response.json({ registered: false, supported: true });
        return status instanceof Error ? Promise.reject(status) : new Response('', { status });
      },
    },
  };
}

test('turning off reports a PC that could not be asked, and a browser that kept the subscription', async () => {
  const { environment, relayKey } = await oneRelayPc(503);
  await assert.rejects(unregisterRelayPushSubscription('https://push.example.com/x', environment), /relay 503/u);
  const offline = await oneRelayPc(new Error('offline'));
  await assert.rejects(unregisterRelayPushSubscription('https://push.example.com/x', offline.environment), /offline/u);
  // A PC whose credential the relay refused holds nothing under it.
  const gone = await oneRelayPc(401);
  await unregisterRelayPushSubscription('https://push.example.com/x', gone.environment);

  const ok = await oneRelayPc(200);
  const stuck = fakeSubscription('https://push.example.com/x', relayKey);
  stuck.unsubscribe = async () => false;
  await assert.rejects(removePushSubscription(undefined, { getSubscription: async () => stuck }, ok.environment));
  const lingering = fakeSubscription('https://push.example.com/x', relayKey);
  await assert.rejects(removePushSubscription(undefined, { getSubscription: async () => lingering }, ok.environment));
  const off = fakeSubscription('https://push.example.com/x', relayKey);
  let current = off;
  const pushManager = { getSubscription: async () => current };
  off.unsubscribe = async () => {
    current = null;
    return true;
  };
  await removePushSubscription(undefined, pushManager, ok.environment);
  assert.equal(current, null);
  // The PC refusing keeps the browser subscribed, so the toggle can stay ON.
  const refused = await oneRelayPc(503);
  const kept = fakeSubscription('https://push.example.com/x', relayKey);
  // The browser is still unsubscribed locally; the server failure is reported on its own.
  await assert.rejects(
    removePushSubscription(
      undefined,
      { getSubscription: async () => (kept.unsubscribed ? null : kept) },
      refused.environment
    ),
    PushServerCleanupError
  );
  assert.equal(kept.unsubscribed, true);
});

test('turning off during a relay outage still unsubscribes the browser and reports the server failure', async () => {
  const { environment, relayKey } = await oneRelayPc(new Error('offline'));
  const sub = fakeSubscription('https://push.example.com/x', relayKey);
  let current = sub;
  sub.unsubscribe = async () => {
    current = null;
    return true;
  };
  await assert.rejects(
    removePushSubscription(undefined, { getSubscription: async () => current }, environment),
    (error) => error instanceof PushServerCleanupError && /offline/u.test(error.cause.message)
  );
  assert.equal(current, null);
});

test('turning off when /webpush/key fails still unsubscribes the browser', async () => {
  const { environment, relayKey } = await oneRelayPc(200);
  for (const failure of [new Error('offline'), new Response('', { status: 500 }), new Response('', { status: 429 })]) {
    const sub = fakeSubscription('https://push.example.com/x', relayKey);
    let current = sub;
    sub.unsubscribe = async () => {
      current = null;
      return true;
    };
    const keyFails = {
      ...environment,
      fetch: async (url, init) => {
        if (url !== '/webpush/key') return environment.fetch(url, init);
        if (failure instanceof Error) throw failure;
        return failure.clone();
      },
    };
    try {
      await removePushSubscription(undefined, { getSubscription: async () => current }, keyFails);
    } catch (error) {
      assert.ok(error instanceof PushServerCleanupError);
    }
    assert.equal(current, null);
  }
});

test('an existing subscription is not "on" until a PC confirmed it; a partial registration says so', async () => {
  const world = await mixedPcs([PC_A, PC_B]);
  world.useRelayKeyed();
  const answer = world.environment.fetch;
  const failing =
    (pcs) =>
    async (url, init = {}) => {
      const pc = init.headers?.Authorization?.endsWith('a'.repeat(64)) ? PC_A : PC_B;
      return url === '/webpush/register' && pcs.includes(pc) ? new Response('', { status: 503 }) : answer(url, init);
    };
  const state = (create = true) =>
    withPushGlobals(world.pushManager, () =>
      statePushSubscription(world.api, world.pushManager, create, world.environment)
    );

  world.environment.fetch = failing([PC_A, PC_B]);
  const none = await state();
  assert.ok(none.subscription);
  assert.equal(none.confirmed, false);
  assert.equal(none.complete, false);

  world.environment.fetch = failing([PC_B]);
  const partial = await state();
  assert.equal(partial.confirmed, true);
  assert.equal(partial.complete, false, 'PC B still has to be retried');
  assert.deepEqual(
    partial.hosts.map(({ deviceId, registered }) => [deviceId, registered]),
    [
      [PC_A, true],
      [PC_B, false],
    ]
  );

  world.environment.fetch = failing([]);
  const retried = await state(false);
  assert.equal(retried.complete, true);
  assert.deepEqual(
    retried.hosts.map(({ registered }) => registered),
    [true, true]
  );
});

test('a renewed subscription reaches the open app, which restates it at once', async () => {
  const windows = [];
  const subscribed = [];
  const worker = loadWorker({
    caches: memoryCacheStorage(),
    windows: [{ url: `${WORKER_ORIGIN}/`, postMessage: (m) => windows.push(m) }],
    pushManager: { subscribe: async (options) => subscribed.push(options) },
  });
  assert.equal(worker.PUSH_SUBSCRIPTION_CHANGED_MESSAGE, PUSH_SUBSCRIPTION_CHANGED_MESSAGE);
  const change = async (event) => {
    let settled;
    worker.listeners.get('pushsubscriptionchange')({ ...event, waitUntil: (p) => (settled = p) });
    await settled;
  };
  const key = new Uint8Array([4, 1, 2]).buffer;
  await change({ oldSubscription: { options: { applicationServerKey: key } } });
  assert.equal(subscribed.length, 1, 'renewed with the same sender key');
  await change({ newSubscription: { endpoint: 'https://push.example.com/new' } });
  assert.equal(subscribed.length, 1, 'the browser already renewed it');
  assert.deepEqual(
    windows.map((message) => message.type),
    [PUSH_SUBSCRIPTION_CHANGED_MESSAGE, PUSH_SUBSCRIPTION_CHANGED_MESSAGE]
  );

  let calls = 0;
  const api = { registerPushSubscription: async () => (calls += 1) };
  const messages = workerMessages();
  const target = { addEventListener() {}, removeEventListener() {} };
  const stop = installPushSubscriptionSync(
    api,
    'ready',
    target,
    { fetch: async () => new Response('', { status: 404 }), now: () => clock },
    messages
  );
  await withPushGlobals(
    { getSubscription: async () => fakeSubscription('https://push.example.com/new', null) },
    async () => {
      messages.send({ type: 'mixdog:other' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls, 0);
      messages.send({ type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls, 1);
      // Already stated this launch, yet a second renewal is still published.
      messages.send({ type: PUSH_SUBSCRIPTION_CHANGED_MESSAGE });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls, 2);
    }
  );
  stop();
  assert.equal(messages.handlers.size, 0);
});

test('a stated subscription is restated for a re-paired PC and after the PC had time to restart', async () => {
  const origin = 'https://relay.mixdog.test';
  const pairing = relayE2EEPairingMaterial(await generateRelayE2EEServerIdentity());
  const storage = pairedStorage(origin, [{ deviceId: PC_A, token: 'a'.repeat(64), pairing }]);
  let calls = 0;
  const api = { registerPushSubscription: async () => (calls += 1) };
  let ready;
  const target = {
    addEventListener: (_name, listener) => (ready = listener),
    removeEventListener() {},
  };
  installPushSubscriptionSync(
    api,
    'ready',
    target,
    {
      origin,
      storage,
      currentHostId: PC_A,
      hostIds: [],
      fetch: async () => new Response('', { status: 404 }),
      now: () => clock,
    },
    workerMessages()
  );
  await withPushGlobals(
    { getSubscription: async () => fakeSubscription('https://push.example.com/1', null) },
    async () => {
      const connect = async () => {
        ready();
        await new Promise((resolve) => setTimeout(resolve, 10));
      };
      await connect();
      await connect();
      assert.equal(calls, 1);
      // Re-paired: a new credential the relay has never seen.
      const keys = remotePairingKeys(origin, PC_A);
      storage.setItem(keys.token, 'c'.repeat(64));
      await connect();
      assert.equal(calls, 2);
      // The PC restarted (perhaps updated) some time later.
      clock += PUSH_RESTATE_INTERVAL_MS + 1;
      await connect();
      assert.equal(calls, 3);
    }
  );
});

test('only a browser with no push service is told so; transient and unknown failures are retryable', async () => {
  const pcKey = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 2)]).toString('base64url');
  const legacyRelay = async () => new Response('', { status: 404 });
  const api = { pushPublicKey: async () => pcKey, registerPushSubscription: async () => true };
  const failing = (error) => ({
    getSubscription: async () => null,
    subscribe: async () => {
      throw error;
    },
  });
  assert.equal(
    await enableFailure(api, failing(new DOMException('unsupported', 'NotSupportedError')), legacyRelay),
    'push-service'
  );
  for (const error of [
    new DOMException('offline', 'NetworkError'),
    new DOMException('state', 'InvalidStateError'),
    new Error('who knows'),
  ]) {
    assert.equal(await enableFailure(api, failing(error), legacyRelay), 'failed', String(error));
  }
});
