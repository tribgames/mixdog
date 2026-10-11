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
  statePushSubscription,
  syncPushSubscription,
} from './push-notification-bridge';
import { remotePairingKeys } from './remote-pairing-recovery';
import {
  generateRelayE2EEServerIdentity,
  openRelayWebPushKeys,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
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
    installPushSubscriptionSync(api, 'ready', target, { fetch: async () => new Response('', { status: 404 }) });
    const fire = async () => {
      for (const listener of [...listeners]) listener();
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await fire(); // dropped under the call
    assert.equal(calls, 1);
    assert.equal(listeners.size, 1, 'still waiting for a connection that can carry it');
    await fire(); // the next connection delivers it
    assert.equal(calls, 2);
    assert.equal(listeners.size, 0, 'accepted once: no further statements this launch');
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
  await push(running, { hostId: PC_B, sessionId: 's-1', title: 'B', body: 'done', data: { sessionId: 's-1', hostId: PC_B } });
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
  assert.deepEqual(routeNotificationTap({ sessionId: 's', hostId: PC_A }, environment), { action: 'open', sessionId: 's' });
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
  assert.deepEqual(routeNotificationTap({ sessionId: 's', hostId: '' }, environment), { action: 'open', sessionId: 's' });
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
    { deviceId: PC_A, token: 'a'.repeat(64), pairing: relayE2EEPairingMaterial(await generateRelayE2EEServerIdentity()) },
    { deviceId: PC_B, token: 'b'.repeat(64), pairing: relayE2EEPairingMaterial(await generateRelayE2EEServerIdentity()) },
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
  assert.equal(await withPushGlobals(world.pushManager, () => syncPushSubscription(world.api, world.environment)), true);
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
  assert.equal(await withPushGlobals(world.pushManager, () => syncPushSubscription(world.api, world.environment)), true);
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
