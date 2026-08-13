import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRemoteExternalUrl,
  normalizeRemoteRelayOrigin,
  parseRemotePairingLink,
} from './remote-pairing-recovery.ts';

const token = 'a'.repeat(48);
const serverPublicKey = 'B'.repeat(87);
const pairingSecret = 'c'.repeat(43);
const pairingUrl = (origin = 'https://relay.example') =>
  `${origin}/?token=${token}#e2eeKey=${serverPublicKey}&e2eeSecret=${pairingSecret}`;

test('remote pairing accepts complete HTTPS and loopback links', () => {
  assert.deepEqual(parseRemotePairingLink(pairingUrl()), {
    url: pairingUrl(),
    origin: 'https://relay.example',
    token,
    serverPublicKey,
    pairingSecret,
  });
  assert.equal(
    parseRemotePairingLink(pairingUrl('http://127.0.0.1:9800'))?.origin,
    'http://127.0.0.1:9800',
  );
  assert.equal(
    parseRemotePairingLink(pairingUrl('http://localhost:9800'))?.origin,
    'http://localhost:9800',
  );
});

test('remote pairing rejects insecure, credentialed, and incomplete links', () => {
  assert.equal(parseRemotePairingLink(pairingUrl('http://relay.example')), null);
  assert.equal(parseRemotePairingLink(pairingUrl('https://user@relay.example')), null);
  assert.equal(parseRemotePairingLink('https://relay.example/?token=abc'), null);
  assert.equal(
    parseRemotePairingLink(
      `https://relay.example/?token=${token}#e2eeKey=${serverPublicKey}`,
    ),
    null,
  );
});

test('stored relay origins require HTTPS except for loopback', () => {
  assert.equal(normalizeRemoteRelayOrigin('https://relay.example/path'), 'https://relay.example');
  assert.equal(normalizeRemoteRelayOrigin('http://relay.example'), '');
  assert.equal(normalizeRemoteRelayOrigin('http://[::1]:9800/path'), 'http://[::1]:9800');
  assert.equal(normalizeRemoteRelayOrigin('javascript:alert(1)'), '');
});

test('remote external navigation permits only HTTP and HTTPS', () => {
  assert.equal(normalizeRemoteExternalUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(normalizeRemoteExternalUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeRemoteExternalUrl('javascript:alert(1)'), '');
  assert.equal(normalizeRemoteExternalUrl('data:text/html,payload'), '');
  assert.equal(normalizeRemoteExternalUrl('file:///etc/passwd'), '');
});
