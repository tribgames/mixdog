import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TURN_CREDENTIAL_TTL_SECONDS,
  TURN_DEFAULT_PORT,
  TURN_DEFAULT_TLS_PORT,
  TURN_SECRET_MIN_BYTES,
  iceServersFor,
  issueTurnCredential,
  stunUrls,
  turnConfigFromEnv,
  turnPassword,
  turnUrls,
  turnUserId,
  verifyTurnCredential,
} from './turn-credentials.mjs';

const SECRET = 'a'.repeat(64);
const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
const ENV = { TURN_AUTH_SECRET: SECRET, TURN_HOST: 'relay.example.com', TURN_ISSUE_LIMIT: '4' };

test('the password is base64(HMAC-SHA1) of the username (RFC 2202 test case 2)', () => {
  // key "Jefe", data "what do ya want for nothing?" -> effcdf6a... (RFC 2202 §3).
  const digest = 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79';
  assert.equal(turnPassword('Jefe', 'what do ya want for nothing?'), Buffer.from(digest, 'hex').toString('base64'));
});

test('a credential is "<expiry>:<id>" valid for one day by default and verifies like coturn would', () => {
  const issued = issueTurnCredential({ secret: SECRET, userId: 'device1', nowMs: NOW });
  assert.equal(TURN_CREDENTIAL_TTL_SECONDS, 86_400);
  assert.equal(issued.ttlSeconds, 86_400);
  assert.equal(issued.expiresAt, NOW / 1000 + 86_400);
  assert.equal(issued.remainingMs, 86_400_000);
  assert.equal(issued.username, `${issued.expiresAt}:device1`);
  assert.equal(issued.credential, turnPassword(SECRET, issued.username));
  const check = (nowMs, overrides = {}) =>
    verifyTurnCredential({ secret: SECRET, username: issued.username, credential: issued.credential, nowMs, ...overrides });
  assert.equal(check(NOW), true);
  assert.equal(check(NOW + 86_399_000), true);
  // From the expiry second on, coturn must refuse it.
  assert.equal(check(NOW + 86_400_000), false);
  assert.equal(check(NOW + 90_000_000), false);
});

test('the real lifetime is what is left after the expiry is floored to a whole second', () => {
  // Issued 999 ms into a second: coturn stops accepting it at the expiry second,
  // 999 ms before ttlSeconds have passed.
  const issued = issueTurnCredential({ secret: SECRET, userId: 'device1', nowMs: NOW + 999 });
  assert.equal(issued.expiresAt, NOW / 1000 + 86_400);
  assert.equal(issued.remainingMs, 86_400_000 - 999);
  const verify = (nowMs) =>
    verifyTurnCredential({ secret: SECRET, username: issued.username, credential: issued.credential, nowMs });
  assert.equal(verify(NOW + 999 + issued.remainingMs - 1), true);
  assert.equal(verify(NOW + 999 + issued.remainingMs), false);
  const onTheSecond = issueTurnCredential({ secret: SECRET, userId: 'device1', nowMs: NOW });
  assert.equal(onTheSecond.remainingMs, 86_400_000);
});

test('a credential cannot be forged, altered, extended or used with another secret', () => {
  const issued = issueTurnCredential({ secret: SECRET, userId: 'device1', nowMs: NOW, ttlSeconds: 600 });
  const verify = (fields) => verifyTurnCredential({ secret: SECRET, nowMs: NOW, ...fields });
  assert.equal(verify({ username: issued.username, credential: issued.credential }), true);
  assert.equal(verify({ username: issued.username, credential: `${issued.credential}x` }), false);
  assert.equal(verify({ username: issued.username, credential: 'A'.repeat(issued.credential.length) }), false);
  // Moving the expiry later (or the user id) breaks the password.
  assert.equal(verify({ username: `${issued.expiresAt + 3600}:device1`, credential: issued.credential }), false);
  assert.equal(verify({ username: `${issued.expiresAt}:device2`, credential: issued.credential }), false);
  assert.equal(
    verifyTurnCredential({ secret: 'b'.repeat(64), nowMs: NOW, username: issued.username, credential: issued.credential }),
    false
  );
  for (const username of ['', 'device1', 'x:device1', `${issued.expiresAt}:`, null, undefined, 7]) {
    assert.equal(verify({ username, credential: turnPassword(SECRET, String(username)) }), false, String(username));
  }
  assert.equal(verify({ username: issued.username, credential: undefined }), false);
});

test('the user id is the full keyed digest, stable per device, opaque, and bound to the secret', () => {
  const deviceId = '3f2a9c1e-5b7d-4e68-9a10-2c4d6e8f0a1b';
  const id = turnUserId(SECRET, deviceId);
  assert.match(id, /^[0-9a-f]{64}$/u);
  // RFC 8489 §14.3: a USERNAME is fewer than 509 bytes.
  const { username } = issueTurnCredential({ secret: SECRET, userId: id, nowMs: NOW });
  assert.ok(Buffer.byteLength(username) < 509, String(Buffer.byteLength(username)));
  assert.equal(turnUserId(SECRET, deviceId), id);
  assert.notEqual(turnUserId(SECRET, 'another-device'), id);
  assert.notEqual(turnUserId('b'.repeat(64), deviceId), id);
  assert.equal(id.includes(deviceId.slice(0, 8)), false);
});

test('settings come from the deploy environment and fail closed', () => {
  assert.equal(turnConfigFromEnv({}), null);
  assert.equal(turnConfigFromEnv(undefined), null);
  const config = turnConfigFromEnv(ENV);
  assert.deepEqual(
    { host: config.host, port: config.port, tlsPort: config.tlsPort, ttlSeconds: config.ttlSeconds, issueLimit: config.issueLimit },
    { host: 'relay.example.com', port: TURN_DEFAULT_PORT, tlsPort: 0, ttlSeconds: 86_400, issueLimit: 4 }
  );
  assert.equal(TURN_DEFAULT_PORT, 3478);
  assert.equal(TURN_DEFAULT_TLS_PORT, 5349);
  assert.equal(turnConfigFromEnv({ ...ENV, TURN_PORT: '3479', TURN_TLS_PORT: '5350' }).tlsPort, 5350);
  assert.equal(Object.isFrozen(config), true);

  assert.throws(() => turnConfigFromEnv({ TURN_AUTH_SECRET: SECRET }), /both/u);
  assert.throws(() => turnConfigFromEnv({ TURN_HOST: 'relay.example.com' }), /both/u);
  // The request limit is a deploy-time decision: no value, no issuance.
  const { TURN_ISSUE_LIMIT: _limit, ...withoutLimit } = ENV;
  assert.throws(() => turnConfigFromEnv(withoutLimit), /TURN_ISSUE_LIMIT/u);
  for (const limit of ['', '0', '-1', '1.5', 'many', '1e3', ' 3']) {
    assert.throws(() => turnConfigFromEnv({ ...ENV, TURN_ISSUE_LIMIT: limit }), /TURN_ISSUE_LIMIT/u, limit);
  }
  assert.equal(turnConfigFromEnv({ ...ENV, TURN_ISSUE_LIMIT: '30' }).issueLimit, 30);
  assert.throws(
    () => turnConfigFromEnv({ ...ENV, TURN_AUTH_SECRET: 'x'.repeat(TURN_SECRET_MIN_BYTES - 1) }),
    /at least 20 bytes/u
  );
  assert.doesNotThrow(() => turnConfigFromEnv({ ...ENV, TURN_AUTH_SECRET: 'x'.repeat(TURN_SECRET_MIN_BYTES) }));
  for (const host of ['bad host', 'a/b', 'host:3478', '-lead.example.com', 'trail.example.com.-', '[::1]']) {
    assert.throws(() => turnConfigFromEnv({ ...ENV, TURN_HOST: host }), /host/u, host);
  }
  for (const port of ['0', '65536', 'abc', '3478.5', '-1']) {
    assert.throws(() => turnConfigFromEnv({ ...ENV, TURN_PORT: port }), /TURN_PORT/u, port);
    assert.throws(() => turnConfigFromEnv({ ...ENV, TURN_TLS_PORT: port }), /TURN_TLS_PORT/u, port);
  }
});

test('the ICE list names only this host: STUN, then TURN over udp, tcp and (when provisioned) tls', () => {
  const plain = turnConfigFromEnv(ENV);
  assert.deepEqual(stunUrls(plain), ['stun:relay.example.com:3478']);
  assert.deepEqual(turnUrls(plain), [
    'turn:relay.example.com:3478?transport=udp',
    'turn:relay.example.com:3478?transport=tcp',
  ]);
  const withTls = turnConfigFromEnv({ ...ENV, TURN_TLS_PORT: '5349' });
  const issued = issueTurnCredential({ secret: SECRET, userId: 'device1', nowMs: NOW });
  assert.deepEqual(iceServersFor(withTls, issued), [
    { urls: ['stun:relay.example.com:3478'] },
    {
      urls: [
        'turn:relay.example.com:3478?transport=udp',
        'turn:relay.example.com:3478?transport=tcp',
        'turns:relay.example.com:5349?transport=tcp',
      ],
      username: issued.username,
      credential: issued.credential,
    },
  ]);
  const hosts = JSON.stringify(iceServersFor(withTls, issued)).match(/(?:stun|turns?):([^:?"]+)/gu);
  assert.ok(hosts.every((entry) => entry.endsWith(':relay.example.com')));
});
