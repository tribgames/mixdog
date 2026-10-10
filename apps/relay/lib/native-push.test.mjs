import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import http2 from 'node:http2';
import test from 'node:test';

import { createNativePush } from './native-push.mjs';
import { runDesktopLeg } from './relay-legs.mjs';
import { newUplinkLeg } from './relay-transport.mjs';
import { RateLimiter } from './rate-limit.mjs';

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const APNS_ENV = { APNS_KEY_P8: P8, APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'TEAMID1234' };
const APNS_TOKEN = 'ab'.repeat(32);
const FCM_TOKEN = 'f'.repeat(40) + ':APA91b-token_x';
const serviceAccount = (extra = {}) =>
  JSON.stringify({
    project_id: 'mixdog-test',
    client_email: 'push@mixdog-test.iam.gserviceaccount.com',
    private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth.example.test/token',
    ...extra,
  });

async function apnsServer(respond) {
  const requests = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const { status, body } = respond(requests.length);
      stream.respond({ ':status': status });
      stream.end(body ? JSON.stringify(body) : undefined);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const message = (extra = {}) => ({
  platform: 'apns',
  token: APNS_TOKEN,
  mx: 'bXg',
  reason: 'turn-finished',
  collapseKey: 'collapse-1',
  sandbox: false,
  ...extra,
});

test('no credentials: no platform is advertised and sends fail gracefully', async () => {
  const push = createNativePush({ env: {} });
  assert.deepEqual(push.platforms, []);
  assert.equal((await push.send(message())).ok, false);
  const broken = createNativePush({ env: { APNS_KEY_P8: 'not a key', APNS_KEY_ID: 'a', APNS_TEAM_ID: 'b' }, log: () => {} });
  assert.deepEqual(broken.platforms, []);
});

test('APNs request shape: token auth, headers, mutable-content, approval category', async (t) => {
  const apns = await apnsServer(() => ({ status: 200 }));
  const push = createNativePush({ env: APNS_ENV, origins: { apnsProduction: apns.origin } });
  t.after(() => {
    push.close();
    apns.close();
  });
  assert.deepEqual(push.platforms, ['apns']);
  assert.deepEqual(await push.send(message({ reason: 'approval-pending' })), { ok: true, status: 200 });
  await push.send(message());
  const [approval, ordinary] = apns.requests;
  assert.equal(approval.headers[':path'], `/3/device/${APNS_TOKEN}`);
  assert.equal(approval.headers['apns-topic'], 'io.mixdog.app');
  assert.equal(approval.headers['apns-push-type'], 'alert');
  assert.equal(approval.headers['apns-priority'], '10');
  assert.equal(approval.headers['apns-collapse-id'], 'collapse-1');
  assert.equal(approval.body.mx, 'bXg');
  assert.equal(approval.body.aps['mutable-content'], 1);
  assert.equal(approval.body.aps.category, 'MIXDOG_APPROVAL');
  assert.equal(ordinary.body.aps.category, undefined);
  // Fallback alert carries no session content.
  assert.deepEqual(Object.keys(approval.body.aps.alert).sort(), ['body', 'title']);
  const [header, claims, signature] = approval.headers.authorization.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEYID12345' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAMID1234');
  const verifier = createVerify('sha256').update(`${header}.${claims}`);
  assert.equal(verifier.verify({ key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  // The provider token is reused, not re-signed per push.
  assert.equal(ordinary.headers.authorization, approval.headers.authorization);
});

test('APNs 410 reports the token invalid; other failures do not', async (t) => {
  const apns = await apnsServer((count) =>
    count === 1 ? { status: 410, body: { reason: 'Unregistered' } } : { status: 429, body: { reason: 'TooManyRequests' } }
  );
  const push = createNativePush({ env: APNS_ENV, origins: { apnsProduction: apns.origin } });
  t.after(() => {
    push.close();
    apns.close();
  });
  const gone = await push.send(message());
  assert.equal(gone.ok, false);
  assert.equal(gone.invalid, true);
  const busy = await push.send(message());
  assert.equal(busy.ok, false);
  assert.equal(Boolean(busy.invalid), false);
});

test('APNs sandbox tokens go to the sandbox host', async (t) => {
  const production = await apnsServer(() => ({ status: 200 }));
  const sandbox = await apnsServer(() => ({ status: 200 }));
  const push = createNativePush({
    env: APNS_ENV,
    origins: { apnsProduction: production.origin, apnsSandbox: sandbox.origin },
  });
  t.after(() => {
    push.close();
    production.close();
    sandbox.close();
  });
  await push.send(message({ sandbox: true }));
  await push.send(message({ sandbox: false }));
  assert.equal(sandbox.requests.length, 1);
  assert.equal(production.requests.length, 1);
});

function fcmFetch(sendResponse) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://oauth.example.test')) {
      return Response.json({ access_token: 'ya29.token', expires_in: 3600 });
    }
    return sendResponse();
  };
  return { calls, fetchImpl };
}

test('FCM request shape: service-account JWT exchange, data-only high priority message', async () => {
  const { calls, fetchImpl } = fcmFetch(() => Response.json({ name: 'projects/mixdog-test/messages/1' }));
  const push = createNativePush({ env: { FCM_SERVICE_ACCOUNT_JSON: serviceAccount() }, fetchImpl });
  assert.deepEqual(push.platforms, ['fcm']);
  const result = await push.send(message({ platform: 'fcm', token: FCM_TOKEN }));
  assert.equal(result.ok, true);
  await push.send(message({ platform: 'fcm', token: FCM_TOKEN }));
  // One token exchange, two sends.
  assert.equal(calls.filter((call) => call.url.includes('oauth.example.test')).length, 1);
  const exchange = new URLSearchParams(calls[0].init.body);
  assert.equal(exchange.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = exchange.get('assertion').split('.');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(
    createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(rsa.publicKey, Buffer.from(signature, 'base64url')),
    true
  );
  const send = calls[1];
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/mixdog-test/messages:send');
  assert.equal(send.init.headers.authorization, 'Bearer ya29.token');
  const body = JSON.parse(send.init.body).message;
  assert.equal(body.token, FCM_TOKEN);
  assert.deepEqual(body.data, { mx: 'bXg', reason: 'turn-finished' });
  assert.equal(body.android.priority, 'HIGH');
  assert.equal(body.android.collapse_key, 'collapse-1');
  assert.equal(body.notification, undefined);
});

test('FCM UNREGISTERED reports the token invalid', async () => {
  const { fetchImpl } = fcmFetch(() =>
    Response.json(
      { error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
      { status: 404 }
    )
  );
  const push = createNativePush({ env: { FCM_SERVICE_ACCOUNT_JSON: serviceAccount() }, fetchImpl });
  const result = await push.send(message({ platform: 'fcm', token: FCM_TOKEN }));
  assert.equal(result.ok, false);
  assert.equal(result.invalid, true);
});

// ---- desktop leg: capability, auth binding, cleanup -------------------------

function fakeSocket() {
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (data, callback) => {
    socket.sent.push(JSON.parse(data));
    callback?.();
  };
  socket.close = () => {};
  return socket;
}

function connectDesktop({ deviceId = 'dev-a', store, bindings = new Map(), nativePush, limiter } = {}) {
  const socket = fakeSocket();
  socket.uplinkLeg = newUplinkLeg(64 * 1024);
  const entry = { socket, clients: new Map(), media: new Map(), mediaLane: false };
  runDesktopLeg(
    {
      store,
      sendJson: (target, payload) => target.send(JSON.stringify(payload)),
      attachDesktop: () => entry,
      liveDesktops: new Map([[deviceId, entry]]),
      claims: new Map(),
      maxFrameBytes: 1 << 20,
      nativePush,
      nativeBindings: bindings,
      nativeLimiter: limiter ?? new RateLimiter(100, 60_000),
    },
    deviceId,
    socket
  );
  const emit = (payload) => socket.emit('message', Buffer.from(JSON.stringify(payload)), false);
  return { socket, emit, bindings };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const clientsOf = (map) => ({ hasClient: (device, client) => map[device]?.includes(client) === true });

function fakeNativePush(platforms = ['apns', 'fcm'], result = { ok: true, status: 200 }) {
  const sent = [];
  return { platforms, sent, send: async (m) => (sent.push(m), result) };
}

test('capabilities advertise native push only when the relay can deliver', () => {
  const none = connectDesktop({ store: {}, nativePush: null });
  assert.equal(none.socket.sent[0].type, 'relay-capabilities');
  assert.equal('nativePush' in none.socket.sent[0], false);
  const able = connectDesktop({ store: {}, nativePush: fakeNativePush(['apns']) });
  assert.equal(able.socket.sent[0].nativePush, 1);
  assert.deepEqual(able.socket.sent[0].nativePushPlatforms, ['apns']);
});

const send = (extra = {}) => ({
  type: 'native-push',
  platform: 'apns',
  token: APNS_TOKEN,
  mx: 'bXg',
  reason: 'turn-finished',
  collapseKey: 'c1',
  sandbox: false,
  ...extra,
});
const bind = (extra = {}) => ({ type: 'native-push-bind', clientId: 'client-1', platform: 'apns', token: APNS_TOKEN, ...extra });

test('only the desktop that bound a token to its own paired client can send to it', async () => {
  const store = clientsOf({ 'dev-a': ['client-1'], 'dev-b': ['client-9'] });
  const push = fakeNativePush();
  const bindings = new Map();
  const a = connectDesktop({ deviceId: 'dev-a', store, bindings, nativePush: push });
  const b = connectDesktop({ deviceId: 'dev-b', store, bindings, nativePush: push });

  a.emit(send());
  await settle();
  assert.equal(a.socket.sent.at(-1).error, 'unbound-token');

  // A client the desktop does not own cannot be bound.
  a.emit(bind({ clientId: 'client-9' }));
  a.emit(send());
  await settle();
  assert.equal(a.socket.sent.at(-1).error, 'unbound-token');

  a.emit(bind());
  a.emit(send());
  await settle();
  assert.equal(push.sent.length, 1);
  assert.deepEqual(a.socket.sent.at(-1), {
    type: 'native-push-result',
    platform: 'apns',
    token: APNS_TOKEN,
    collapseKey: 'c1',
    ok: true,
    status: 200,
  });

  // Another device can neither send to nor steal a live binding.
  b.emit(send());
  b.emit(bind({ clientId: 'client-9' }));
  b.emit(send());
  await settle();
  assert.equal(push.sent.length, 1);
  assert.equal(b.socket.sent.at(-1).error, 'unbound-token');
});

test('unpairing a client drops its bindings; a stale binding can be re-bound', async () => {
  const paired = { 'dev-a': ['client-1'], 'dev-b': ['client-9'] };
  const store = clientsOf(paired);
  const push = fakeNativePush();
  const bindings = new Map();
  const a = connectDesktop({ deviceId: 'dev-a', store, bindings, nativePush: push });
  const b = connectDesktop({ deviceId: 'dev-b', store, bindings, nativePush: push });
  a.emit(bind());
  paired['dev-a'] = [];
  // The paired client is gone from the store: the binding is dead even though it lingers.
  a.emit(send());
  await settle();
  assert.equal(a.socket.sent.at(-1).error, 'unbound-token');
  b.emit(bind({ clientId: 'client-9' }));
  b.emit(send());
  await settle();
  assert.equal(push.sent.length, 1);
});

test('invalid tokens reported by the platform are dropped and the desktop is told', async () => {
  const store = clientsOf({ 'dev-a': ['client-1'] });
  const push = fakeNativePush(['apns'], { ok: false, status: 410, invalid: true, error: 'Unregistered' });
  const bindings = new Map();
  const a = connectDesktop({ store, bindings, nativePush: push });
  a.emit(bind());
  a.emit(send());
  await settle();
  const result = a.socket.sent.at(-1);
  assert.equal(result.type, 'native-push-result');
  assert.equal(result.invalid, true);
  assert.equal(result.token, APNS_TOKEN);
  assert.equal(bindings.has(APNS_TOKEN), false);
});

test('sends are validated and rate limited per device', async () => {
  const store = clientsOf({ 'dev-a': ['client-1'] });
  const push = fakeNativePush();
  const a = connectDesktop({ store, nativePush: push, limiter: new RateLimiter(2, 60_000) });
  a.emit(bind());
  a.emit(send({ mx: 'x'.repeat(4000) }));
  a.emit(send({ reason: 'weird' }));
  a.emit(send({ collapseKey: 'bad key!' }));
  await settle();
  assert.deepEqual(a.socket.sent.slice(-3).map((m) => m.error), ['invalid-message', 'invalid-message', 'invalid-message']);
  a.emit(send());
  a.emit(send());
  a.emit(send());
  await settle();
  assert.equal(push.sent.length, 2);
  assert.equal(a.socket.sent.filter((m) => m.error === 'rate-limited').length, 1);
});

test('a relay without credentials ignores native push frames (old/unconfigured relay)', async () => {
  const store = clientsOf({ 'dev-a': ['client-1'] });
  const a = connectDesktop({ store, nativePush: null });
  const before = a.socket.sent.length;
  a.emit(bind());
  a.emit(send());
  await settle();
  assert.equal(a.socket.sent.length, before);
});
