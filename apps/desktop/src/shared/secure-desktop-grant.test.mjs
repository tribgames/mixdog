import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  generateSecureDesktopControllerKey,
  isSecureDesktopControllerKey,
  secureDesktopGrantPayload,
  signSecureDesktopGrant,
} from './secure-desktop-grant.ts';

const NONCE = Buffer.alloc(16, 0x11).toString('base64');
const CHALLENGE = Buffer.alloc(16, 0x22).toString('base64');

/** The vector the helper's Rust tests verify with CNG
 *  (security.rs `a_web_crypto_signature_verifies_and_any_change_breaks_it`). */
const VECTOR_KEY = 'BGmDdwJf4BSehYdpCvbHI135xhoxm4OLAwcr_bRgR1VAL6_vv3-RMLJdSP96rgjWFfZGJWWNEpQ0xJQDo3VGDx0';
const VECTOR_SIGNATURE = 'QDG5C7xJRVBbZyZlxt5KWaaUgBoE3CYU9Cg6H2A4/EaKa6Kn61Istg/11rw3n998xAJusito4Kbh99L+rJx4Bg==';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const verify = async (publicKey, signature, payload) =>
  crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64url'), ECDSA, false, ['verify']),
    Buffer.from(signature, 'base64'),
    payload
  );

test('the payload matches the byte layout the helper verifies', () => {
  assert.equal(
    Buffer.from(secureDesktopGrantPayload(NONCE, CHALLENGE, 7)).toString('hex'),
    '6d6978646f672d7365637572652d6465736b746f702d6772616e742d76310011111111111111111111111111111111' +
      '222222222222222222222222222222220000000000000007'
  );
  assert.throws(() => secureDesktopGrantPayload('short', CHALLENGE, 1), /nonce/);
  assert.throws(() => secureDesktopGrantPayload(NONCE, CHALLENGE, -1), /epoch/);
  assert.throws(() => secureDesktopGrantPayload(NONCE, CHALLENGE, 1.5), /epoch/);
});

test('the shared vector verifies against its payload, and only that payload', async () => {
  assert.ok(isSecureDesktopControllerKey(VECTOR_KEY));
  assert.equal(await verify(VECTOR_KEY, VECTOR_SIGNATURE, secureDesktopGrantPayload(NONCE, CHALLENGE, 7)), true);
  assert.equal(await verify(VECTOR_KEY, VECTOR_SIGNATURE, secureDesktopGrantPayload(NONCE, CHALLENGE, 8)), false);
});

test('a generated key signs grants the enrolled public key verifies; the private key never exports', async () => {
  const key = await generateSecureDesktopControllerKey();
  assert.ok(isSecureDesktopControllerKey(key.publicKey));
  assert.equal(key.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', key.privateKey));
  const signature = await signSecureDesktopGrant(key.privateKey, { nonce: NONCE, challenge: CHALLENGE }, 3);
  assert.equal(Buffer.from(signature, 'base64').length, 64, 'r ‖ s, as the helper expects');
  assert.equal(await verify(key.publicKey, signature, secureDesktopGrantPayload(NONCE, CHALLENGE, 3)), true);
  assert.equal(await verify(key.publicKey, signature, secureDesktopGrantPayload(CHALLENGE, NONCE, 3)), false);
});

test("the helper's grant cadence and lifetime are the relay's liveness probe and silent-leg bound", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const security = read('../../../../native/mixdog-secure-desktop/src/security.rs');
  const relay = read('../../../relay/lib/relay-legs.mjs');
  const secs = (name) =>
    Number(new RegExp(`const ${name}: Duration = Duration::from_secs\\((\\d+)\\);`, 'u').exec(security)?.[1]);
  const ms = (name) =>
    Number(new RegExp(`export const ${name} = ([\\d_]+);`, 'u').exec(relay)?.[1].replaceAll('_', ''));
  assert.equal(secs('GRANT_REFRESH') * 1000, ms('DESKTOP_LIVENESS_PROBE_MS'));
  assert.equal(secs('RELAY_HANDSHAKE_STALL') * 1000, ms('DESKTOP_HANDSHAKE_STALL_MS'));
  assert.match(
    security,
    /pub const GRANT_LIFETIME: Duration =\s+Duration::from_secs\(RELAY_HANDSHAKE_STALL\.as_secs\(\) \+ GRANT_REFRESH\.as_secs\(\)\);/u,
    'the lifetime is the sum of the two'
  );
});

test('only uncompressed P-256 points are enrollable keys', () => {
  assert.equal(isSecureDesktopControllerKey(VECTOR_KEY.replace(/^BG/u, 'Am')), false);
  assert.equal(isSecureDesktopControllerKey(VECTOR_KEY.slice(1)), false);
  assert.equal(isSecureDesktopControllerKey(42), false);
});
