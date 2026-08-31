import assert from 'node:assert/strict';
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify as cryptoVerify,
} from 'node:crypto';
import test from 'node:test';

import {
  encryptWebPushPayload,
  generateWebPushKeys,
  MAX_WEB_PUSH_PAYLOAD_BYTES,
  sendWebPush,
  vapidAuthorizationHeader,
} from './web-push.ts';

/** Stands in for the browser: it holds the keys a real PushSubscription
 *  reports and is the only party that can read what the desktop sent. */
function createSubscriber(endpoint = 'https://push.example.test/subscription/abc') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.of(0x04),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const auth = randomBytes(16);
  return {
    privateKey,
    raw,
    subscription: {
      endpoint,
      p256dh: raw.toString('base64url'),
      auth: auth.toString('base64url'),
    },
    authSecret: auth,
  };
}

/** The receiving half of RFC 8291, written independently of the sender so a
 *  matching pair of mistakes cannot pass. */
function decryptAsBrowser(subscriber, body) {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const senderPublicRaw = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const senderPublic = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: senderPublicRaw.subarray(1, 33).toString('base64url'),
      y: senderPublicRaw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const shared = diffieHellman({ privateKey: subscriber.privateKey, publicKey: senderPublic });
  const hkdf = (hkdfSalt, ikm, info, length) =>
    Buffer.from(new Uint8Array(hkdfSync('sha256', ikm, hkdfSalt, info, length)));
  const ikm = hkdf(
    subscriber.authSecret,
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0'), subscriber.raw, senderPublicRaw]),
    32,
  );
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  assert.equal(padded[padded.length - 1], 0x02, 'last record must end with the 0x02 delimiter');
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

test('the subscribing browser can decrypt what the desktop sent', () => {
  const subscriber = createSubscriber();
  const payload = JSON.stringify({ title: '작업 완료', body: 'Build finished · 12 files' });
  const body = encryptWebPushPayload(subscriber.subscription, payload);
  assert.equal(decryptAsBrowser(subscriber, body), payload);
});

test('every message uses a fresh salt and ephemeral key', () => {
  const subscriber = createSubscriber();
  const first = encryptWebPushPayload(subscriber.subscription, 'same text');
  const second = encryptWebPushPayload(subscriber.subscription, 'same text');
  assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16));
  assert.notDeepEqual(first.subarray(21, 86), second.subarray(21, 86));
  assert.equal(decryptAsBrowser(subscriber, second), 'same text');
});

test('a payload another subscription would need is refused, not truncated', () => {
  const subscriber = createSubscriber();
  assert.throws(
    () => encryptWebPushPayload(subscriber.subscription, 'x'.repeat(MAX_WEB_PUSH_PAYLOAD_BYTES + 1)),
    /exceeds/u,
  );
});

test('a malformed subscription key is rejected before anything is sent', () => {
  assert.throws(() => encryptWebPushPayload(
    { endpoint: 'https://push.example.test/x', p256dh: Buffer.alloc(10).toString('base64url'), auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
    'hello',
  ), /P-256/u);
});

test('the VAPID header is scoped to the push service and verifiable with the public key', () => {
  const keys = generateWebPushKeys();
  const header = vapidAuthorizationHeader({
    endpoint: 'https://push.example.test/subscription/abc?token=1',
    keys,
    subject: 'mailto:push@mixdog.app',
    nowMs: 1_700_000_000_000,
  });
  const [, token, publicKey] = header.match(/^vapid t=([^,]+), k=(.+)$/u);
  assert.equal(publicKey, keys.publicKey);
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://push.example.test');
  assert.equal(claims.sub, 'mailto:push@mixdog.app');
  assert.equal(claims.exp, 1_700_000_000 + 12 * 60 * 60);
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')),
    { typ: 'JWT', alg: 'ES256' },
  );
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const verified = cryptoVerify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    {
      key: createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: raw.subarray(1, 33).toString('base64url'),
          y: raw.subarray(33, 65).toString('base64url'),
        },
        format: 'jwk',
      }),
      dsaEncoding: 'ieee-p1363',
    },
    Buffer.from(signature, 'base64url'),
  );
  assert.equal(verified, true);
});

test('a delivery carries the aes128gcm contract the push service requires', async () => {
  const subscriber = createSubscriber();
  const keys = generateWebPushKeys();
  let seen = null;
  const result = await sendWebPush({
    subscription: subscriber.subscription,
    payload: 'hello phone',
    keys,
    subject: 'mailto:push@mixdog.app',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(result.statusCode, 201);
  assert.equal(result.expired, false);
  assert.equal(seen.url, subscriber.subscription.endpoint);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers['Content-Type'], 'application/octet-stream');
  assert.match(seen.init.headers.Authorization, /^vapid t=/u);
  assert.equal(
    decryptAsBrowser(subscriber, Buffer.from(seen.init.body)),
    'hello phone',
  );
});

test('a subscription the browser dropped is reported as expired', async () => {
  const subscriber = createSubscriber();
  const result = await sendWebPush({
    subscription: subscriber.subscription,
    payload: 'gone',
    keys: generateWebPushKeys(),
    subject: 'mailto:push@mixdog.app',
    fetchImpl: async () => new Response(null, { status: 410 }),
  });
  assert.equal(result.expired, true);
});

test('an unreachable push service never throws into the caller', async () => {
  const subscriber = createSubscriber();
  const result = await sendWebPush({
    subscription: subscriber.subscription,
    payload: 'offline',
    keys: generateWebPushKeys(),
    subject: 'mailto:push@mixdog.app',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(result.statusCode, 0);
  assert.equal(result.expired, false);
  assert.match(result.error, /network down/u);
});
