// Web Push on Node's own crypto: RFC 8291 payload encryption (aes128gcm) and
// RFC 8292 sender authentication (VAPID).
//
// The relay CANNOT send these. It carries E2EE ciphertext only, so it never
// learns that a turn ended or what the session is called. This desktop is the
// sender instead: it signs and encrypts here and posts straight to the push
// service named by the subscription. The payload is sealed with keys only the
// subscribing browser holds, so Google/Apple move bytes they cannot read.
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

/** Sender identity. One pair per desktop, minted once and reused: a browser
 *  binds its subscription to the key it saw, so rotating it silently would
 *  strand every existing subscription. */
export interface WebPushKeys {
  /** base64url uncompressed P-256 point — the `applicationServerKey` a browser
   *  passes to pushManager.subscribe(). */
  publicKey: string;
  /** JWK form so a stored key survives Node/OpenSSL upgrades unchanged. */
  privateKeyJwk: Record<string, unknown>;
}

/** The three fields a browser hands over from PushSubscription.toJSON(). */
export interface WebPushSubscription {
  endpoint: string;
  /** base64url UA public key. */
  p256dh: string;
  /** base64url 16-byte shared authentication secret. */
  auth: string;
}

export interface WebPushSendResult {
  statusCode: number;
  /** 404/410: the browser dropped this subscription for good — the caller must
   *  forget it instead of retrying forever. */
  expired: boolean;
  error?: string;
}

/** Single-record encryption, which is all a notification ever needs. The push
 *  services cap a message at 4 KB including this header. */
const RECORD_SIZE = 4096;
const AES_TAG_BYTES = 16;
const HEADER_BYTES = 16 + 4 + 1 + 65;
/** Leaves room for the padding delimiter and the GCM tag inside one record. */
export const MAX_WEB_PUSH_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - AES_TAG_BYTES - 1;
/** Twelve hours: comfortably inside the spec's 24-hour ceiling even when the
 *  receiving push service disagrees with this machine's clock by a few hours. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
/** A phone that is off or out of range still gets the notification when it
 *  comes back within a day; after that the news is stale anyway. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

function base64urlEncode(data: Buffer): string {
  return data.toString('base64url');
}

/** Accepts base64url and classic base64 alike: subscription JSON from a
 *  browser is base64url, but a hand-copied key can arrive padded. */
function base64urlDecode(value: string): Buffer {
  return Buffer.from(String(value || '').replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
}

function jwkCoordinate(jwk: Record<string, unknown>, name: 'x' | 'y'): Buffer {
  const value = jwk[name];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Web Push key is missing coordinate "${name}".`);
  }
  return base64urlDecode(value);
}

/** The uncompressed point form (0x04 ‖ X ‖ Y) every Web Push field uses. */
function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>;
  return Buffer.concat([
    Buffer.of(0x04),
    jwkCoordinate(jwk, 'x'),
    jwkCoordinate(jwk, 'y'),
  ]);
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('Web Push subscription key is not an uncompressed P-256 point.');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64urlEncode(raw.subarray(1, 33)),
      y: base64urlEncode(raw.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(new Uint8Array(hkdfSync('sha256', ikm, salt, info, length)));
}

export function generateWebPushKeys(): WebPushKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: base64urlEncode(rawPublicKey(publicKey)),
    privateKeyJwk: privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
  };
}

function privateKeyObject(keys: WebPushKeys): KeyObject {
  return createPrivateKey({ key: keys.privateKeyJwk as never, format: 'jwk' });
}

/** The `Authorization` header proving this desktop owns the public key the
 *  browser subscribed with. Scoped to ONE push service origin and short-lived,
 *  so a captured header cannot be replayed elsewhere or for long. */
export function vapidAuthorizationHeader(input: {
  endpoint: string;
  keys: WebPushKeys;
  subject: string;
  nowMs?: number;
}): string {
  const audience = new URL(input.endpoint).origin;
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const header = base64urlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64urlEncode(Buffer.from(JSON.stringify({
    aud: audience,
    exp: issuedAt + VAPID_LIFETIME_SECONDS,
    sub: input.subject,
  })));
  const signingInput = Buffer.from(`${header}.${payload}`);
  // JWS wants the raw r‖s pair; Node's default DER encoding is rejected by
  // every push service with a bare 401.
  const signature = cryptoSign(null, signingInput, {
    key: privateKeyObject(input.keys),
    dsaEncoding: 'ieee-p1363',
  });
  const token = `${header}.${payload}.${base64urlEncode(signature)}`;
  return `vapid t=${token}, k=${input.keys.publicKey}`;
}

/** RFC 8291 §3.4. The salt and the ephemeral pair are injectable so the test
 *  can reproduce a published vector instead of asserting on randomness. */
export function encryptWebPushPayload(
  subscription: WebPushSubscription,
  plaintext: string | Buffer,
  overrides?: { salt?: Buffer; localPrivateKey?: KeyObject; localPublicKey?: KeyObject },
): Buffer {
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  if (body.length > MAX_WEB_PUSH_PAYLOAD_BYTES) {
    throw new Error(`Web Push payload exceeds ${MAX_WEB_PUSH_PAYLOAD_BYTES} bytes.`);
  }
  const userAgentPublicRaw = base64urlDecode(subscription.p256dh);
  const authSecret = base64urlDecode(subscription.auth);
  const userAgentPublic = publicKeyFromRaw(userAgentPublicRaw);
  const salt = overrides?.salt ?? randomBytes(16);
  let localPrivate = overrides?.localPrivateKey;
  let localPublic = overrides?.localPublicKey;
  if (!localPrivate || !localPublic) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    localPrivate = pair.privateKey;
    localPublic = pair.publicKey;
  }
  const localPublicRaw = rawPublicKey(localPublic);
  const sharedSecret = diffieHellman({ privateKey: localPrivate, publicKey: userAgentPublic });
  // The key derivation is bound to BOTH public keys, so a payload encrypted
  // for one subscription cannot be replayed against another.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    userAgentPublicRaw,
    localPublicRaw,
  ]);
  const inputKeyMaterial = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const contentKey = hkdf(
    salt,
    inputKeyMaterial,
    Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'),
    16,
  );
  const nonce = hkdf(
    salt,
    inputKeyMaterial,
    Buffer.from('Content-Encoding: nonce\0', 'utf8'),
    12,
  );
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // 0x02 ends the padding of the LAST record; a lone record is always the last.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([body, Buffer.of(0x02)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.of(localPublicRaw.length),
    localPublicRaw,
    ciphertext,
  ]);
}

/** Post one encrypted notification. Network and protocol failures both resolve
 *  — a phone that cannot be reached must never break the turn that triggered
 *  the notification. */
export async function sendWebPush(input: {
  subscription: WebPushSubscription;
  payload: string;
  keys: WebPushKeys;
  subject: string;
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<WebPushSendResult> {
  const request = input.fetchImpl ?? fetch;
  let body: Buffer;
  let authorization: string;
  try {
    body = encryptWebPushPayload(input.subscription, input.payload);
    authorization = vapidAuthorizationHeader({
      endpoint: input.subscription.endpoint,
      keys: input.keys,
      subject: input.subject,
      nowMs: input.nowMs,
    });
  } catch (error) {
    return {
      statusCode: 0,
      expired: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await request(input.subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
        Urgency: input.urgency ?? 'high',
      },
      body: new Uint8Array(body),
      signal: abort.signal,
    });
    return {
      statusCode: response.status,
      expired: response.status === 404 || response.status === 410,
    };
  } catch (error) {
    return {
      statusCode: 0,
      expired: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
