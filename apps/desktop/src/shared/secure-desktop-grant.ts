/**
 * Control grants for the secure-desktop helper (protocol v4,
 * native/mixdog-secure-desktop/docs/ipc-spec.md "Control grants").
 *
 * The helper (a SYSTEM process) injects input and presses Ctrl+Alt+Del only
 * under a grant the paired phone signed, because the pipe it listens on admits
 * every process of the PC user — not only the Mixdog app — and its input is
 * not subject to UIPI. The phone holds a P-256 signing key generated on the
 * phone as a **non-extractable** Web Crypto key; its public half is enrolled in
 * the helper's protected install state when the phone asks for the helper to
 * be installed. For every helper challenge the phone signs
 *
 *   "mixdog-secure-desktop-grant-v1" ‖ 0x00 ‖ nonce(16) ‖ challenge(16) ‖ epoch (u64 BE)
 *
 * where `nonce` is the helper connection's handshake nonce, `challenge` a
 * one-shot challenge the helper issued, and `epoch` the video run the phone is
 * shown. The desktop app only relays challenges and signatures.
 *
 * Pure Web Crypto, so it runs in the phone's browser and in Node tests alike.
 */

export const SECURE_DESKTOP_GRANT_CONTEXT = 'mixdog-secure-desktop-grant-v1';

/** Raw (uncompressed) P-256 public key length, and the signature length. */
const PUBLIC_KEY_BYTES = 65;
const NONCE_BYTES = 16;

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

function cryptoApi(): Crypto {
  const value = globalThis.crypto;
  if (!value?.subtle) throw new Error('Web Crypto is unavailable.');
  return value;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** A 16-byte base64 value (the helper's nonce / challenge encoding). */
function decodeNonce(value: string, name: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(value);
  } catch {
    throw new Error(`Invalid grant ${name}.`);
  }
  if (bytes.byteLength !== NONCE_BYTES) throw new Error(`Invalid grant ${name}.`);
  return bytes;
}

/** The exact bytes a grant signs (see the header). */
export function secureDesktopGrantPayload(nonce: string, challenge: string, epoch: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid grant epoch.');
  const context = new TextEncoder().encode(SECURE_DESKTOP_GRANT_CONTEXT);
  const payload = new Uint8Array(context.byteLength + 1 + 2 * NONCE_BYTES + 8);
  payload.set(context, 0);
  payload.set(decodeNonce(nonce, 'nonce'), context.byteLength + 1);
  payload.set(decodeNonce(challenge, 'challenge'), context.byteLength + 1 + NONCE_BYTES);
  new DataView(payload.buffer).setBigUint64(payload.byteLength - 8, BigInt(epoch), false);
  return payload;
}

export interface SecureDesktopControllerKey {
  /** Base64url (unpadded) raw public key: what the install enrolls. */
  publicKey: string;
  /** Non-extractable: it can sign, and be stored as a CryptoKey (IndexedDB),
   *  but its bytes can never be read back. */
  privateKey: CryptoKey;
}

/** A fresh controller key for this phone. */
export async function generateSecureDesktopControllerKey(): Promise<SecureDesktopControllerKey> {
  const pair = (await cryptoApi().subtle.generateKey(ECDSA_P256, false, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await cryptoApi().subtle.exportKey('raw', pair.publicKey));
  return { publicKey: encodeBase64Url(raw), privateKey: pair.privateKey };
}

/** Whether `value` is an enrollable public key (unpadded base64url of an
 *  uncompressed P-256 point). */
export function isSecureDesktopControllerKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/u.test(value)) return false;
  const bytes = decodeBase64(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
  return bytes.byteLength === PUBLIC_KEY_BYTES && bytes[0] === 4;
}

/** Sign a helper challenge for video run `epoch`; returns the base64
 *  signature the app relays as `grant.signature`. */
export async function signSecureDesktopGrant(
  privateKey: CryptoKey,
  challenge: { nonce: string; challenge: string },
  epoch: number
): Promise<string> {
  const payload = secureDesktopGrantPayload(challenge.nonce, challenge.challenge, epoch);
  const signature = new Uint8Array(await cryptoApi().subtle.sign(ECDSA_SHA256, privateKey, payload));
  return encodeBase64(signature);
}
