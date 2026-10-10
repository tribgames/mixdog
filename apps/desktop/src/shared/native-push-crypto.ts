// End-to-end encryption of a native (APNs/FCM) push. The desktop encrypts for
// the phone's own P-256 key, so the relay and Apple/Google only ever carry the
// opaque `mx` string.
//
// Fixed contract (mobile implements the decrypt half identically):
//   device key   P-256; `publicKey` = 65-byte uncompressed point, base64url
//   encrypt      ephemeral P-256 key pair per message
//   secret       ECDH(ephemeral private, device public) -> 32-byte x coordinate
//   key          HKDF-SHA256(ikm = secret, salt = empty, info = "mixdog-native-push-v1", 32 bytes)
//   cipher       AES-256-GCM, random 12-byte IV, no AAD, plaintext = UTF-8 JSON
//   `ct`         ciphertext || 16-byte GCM tag (WebCrypto / CryptoKit combined form)
//   `mx`         base64url(UTF-8 JSON `{ v:1, epk, iv, ct }`), epk = 65-byte
//                uncompressed ephemeral public key, iv and ct base64url
import { createCipheriv, createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes } from 'node:crypto';

export const NATIVE_PUSH_INFO = 'mixdog-native-push-v1';
export const NATIVE_PUSH_VERSION = 1;
const TAG_BYTES = 16;
const IV_BYTES = 12;

export type NativePushReason = 'turn-finished' | 'approval-pending' | 'input-needed';

export interface NativePushContent {
  title: string;
  body: string;
  sessionId: string;
  reason: NativePushReason;
  approvalId?: string;
}

/** A device public key is a 65-byte uncompressed P-256 point that is on the curve. */
export function isNativePushPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) return false;
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04 || raw.toString('base64url') !== value) return false;
  try {
    // Throws for a point that is not on the curve.
    createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

function deriveKey(ecdh: ReturnType<typeof createECDH>, peerPublic: Buffer): Buffer {
  const secret = ecdh.computeSecret(peerPublic);
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), NATIVE_PUSH_INFO, 32));
}

/** `ephemeralPrivateKey` and `iv` exist for the shared test vector only. */
export function encryptNativePush(
  devicePublicKey: string,
  content: NativePushContent,
  fixed: { ephemeralPrivateKey?: Buffer; iv?: Buffer } = {}
): string {
  const ecdh = createECDH('prime256v1');
  if (fixed.ephemeralPrivateKey) ecdh.setPrivateKey(fixed.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const key = deriveKey(ecdh, Buffer.from(devicePublicKey, 'base64url'));
  const iv = fixed.iv ?? randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    v: NATIVE_PUSH_VERSION,
    epk: ecdh.getPublicKey().toString('base64url'),
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

/** The phone's half, for tests and as the reference for the mobile code. */
export function decryptNativePush(devicePrivateKey: Buffer, mx: string): NativePushContent {
  const envelope = JSON.parse(Buffer.from(mx, 'base64url').toString('utf8')) as {
    v?: number;
    epk?: string;
    iv?: string;
    ct?: string;
  };
  if (envelope.v !== NATIVE_PUSH_VERSION || !envelope.epk || !envelope.iv || !envelope.ct) {
    throw new TypeError('Unsupported native push envelope.');
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(devicePrivateKey);
  const key = deriveKey(ecdh, Buffer.from(envelope.epk, 'base64url'));
  const ct = Buffer.from(envelope.ct, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  const clear = Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]);
  return JSON.parse(clear.toString('utf8')) as NativePushContent;
}

/** Fixed inputs and the exact `mx` they must produce (test-only keys). */
export const NATIVE_PUSH_TEST_VECTOR = {
  devicePrivateKey: 'MkQCGyPWPK3k6ZYSbLs_DKdI0CN8OO6PnSLcS0m0Dtw',
  devicePublicKey: 'BA3gsNuflWc_YtOOjL4UlR6XsAjDlhnotjRhlhX8bD2uYLd8QaH-VWyEfF8_Q92IyBYFsmuaJEWaMF0OYB5m71o',
  ephemeralPrivateKey: 'iXlhZqRfCiv2mye1cYq3RnadfOjcm1cnd1ufrqaClCM',
  iv: 'AAECAwQFBgcICQoL',
  content: {
    title: 'Mixdog',
    body: 'Build finished: 42 tests passed',
    sessionId: 'session-1',
    reason: 'approval-pending',
    approvalId: 'approval-1',
  } satisfies NativePushContent,
  mx: 'eyJ2IjoxLCJlcGsiOiJCSjFpcjg2WXlVUHpwdjBPaUpiRDF3VzdsR3k1eDFXNm40azk2aXIybF9Yci15TEd0QmM5ZFF4M21wOEhreFJHVTFOTGFQNlZCSU04RG5IRGE4OHE0ZTAiLCJpdiI6IkFBRUNBd1FGQmdjSUNRb0wiLCJjdCI6IlNsSVRmVERORmg3T3hMU0cxOFpGdzVSV0o0UlJLOGV2cDd5VVhoeUpLb21HQTlRS2YyWXNpSi10WldRR0E0U016QldrTWx2aVNfUjladEZ0MzdRYnFyVmlybndWMzRCd0dUQVpqdHFGdG53Qi1aVGRVLUhtWE1MbnNXWTBZbU9WZmZQRWVIVloyU0ZqWTZCT24ydnA5cjFSN1hvXy1hM0RtOE9sN3pJOUlRa0tTU1Y4Wk1UMlg1c0pycUNjZVh6MlVkYWhfcDVnVWlLQSJ9',
};
