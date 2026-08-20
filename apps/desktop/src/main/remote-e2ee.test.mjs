import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  isRelayE2EEHello,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import {
  loadOrCreateRelayE2EEIdentity,
  rotateRelayE2EEIdentity,
} from './remote-e2ee';
import { buildRemoteAccessInfo } from './remote-access-window';
import {
  loadOrCreatePairingToken,
  rotatePairingToken,
} from './remote-pairing-token';

test('authenticates, encrypts both directions, and rejects replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-e2ee-'));
  const identity = await loadOrCreateRelayE2EEIdentity(dir);
  const challenge = createRelayE2EEChallenge();
  const client = await createRelayE2EEClientHandshake(
    relayE2EEPairingMaterial(identity),
    challenge,
  );
  const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);

  const request = await client.channel.encryptJson({ method: 'listProjects', params: [] });
  assert.deepEqual(await server.decryptJson(request), { method: 'listProjects', params: [] });
  await assert.rejects(() => server.decryptJson(request), /replayed/);
  await assert.rejects(
    () => server.decryptJson(JSON.stringify({
      type: 'e2ee-box',
      version: 1,
      sequence: 2,
      nonce: 'A'.repeat(17),
      ciphertext: 'A'.repeat(22),
    })),
    /Expected an encrypted relay frame/,
  );

  const response = await server.encryptJson({ id: 1, ok: true });
  assert.deepEqual(await client.channel.decryptJson(response), { id: 1, ok: true });
  assert.doesNotMatch(request, /listProjects/);

  const binary = await client.channel.encryptBinary({
    method: 'submitToSession',
    params: ['session', 'hello'],
  });
  assert.ok(binary instanceof Uint8Array);
  assert.deepEqual(await server.decryptJson(binary), {
    method: 'submitToSession',
    params: ['session', 'hello'],
  });
  assert.ok(binary.byteLength < (
    await server.encryptJson({ method: 'submitToSession', params: ['session', 'hello'] })
  ).length);
});

test('compresses large payloads inside the envelope and stays readable without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-e2ee-deflate-'));
  const identity = await loadOrCreateRelayE2EEIdentity(dir);
  const pairing = relayE2EEPairingMaterial(identity);
  // A transcript snapshot: repetitive JSON, which is exactly what the relay
  // could never compress once it was ciphertext.
  const snapshot = {
    event: 'sessionState',
    payload: {
      sessionId: 'session',
      items: Array.from({ length: 120 }, (unused, id) => ({
        id,
        kind: id % 2 ? 'assistant' : 'user',
        text: 'the quick brown fox jumps over the lazy dog. '.repeat(12),
      })),
    },
  };

  const offered = { ...createRelayE2EEChallenge(), deflate: 1 };
  const compressed = await createRelayE2EEClientHandshake(pairing, offered);
  assert.equal(compressed.hello.deflate, 1);
  const compressedServer = await acceptRelayE2EEClientHello(identity, offered, compressed.hello);
  const compressedFrame = await compressedServer.encryptBinary(snapshot);
  assert.deepEqual(await compressed.channel.decryptJson(compressedFrame), snapshot);

  // A peer that never advertised compression keeps the original wire format,
  // and the compressing side still reads it.
  const plainChallenge = createRelayE2EEChallenge();
  const plain = await createRelayE2EEClientHandshake(pairing, plainChallenge);
  assert.equal(plain.hello.deflate, undefined);
  const plainServer = await acceptRelayE2EEClientHello(identity, plainChallenge, plain.hello);
  const plainFrame = await plainServer.encryptBinary(snapshot);
  assert.deepEqual(await plain.channel.decryptJson(plainFrame), snapshot);

  assert.ok(
    compressedFrame.byteLength * 3 < plainFrame.byteLength,
    `expected a large saving, got ${compressedFrame.byteLength} vs ${plainFrame.byteLength}`,
  );

  // Small live frames skip compression entirely: the streaming path must not
  // pay for a deflate round that saves nothing.
  const tick = { event: 'sessionState', payload: { sessionId: 'session', append: 'ok' } };
  const smallCompressed = await compressedServer.encryptBinary(tick);
  const smallPlain = await plainServer.encryptBinary(tick);
  assert.equal(smallCompressed.byteLength, smallPlain.byteLength);
  assert.deepEqual(await compressed.channel.decryptJson(smallCompressed), tick);
});

test('rejects oversized handshake fields before cryptographic work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-e2ee-shape-'));
  const identity = await loadOrCreateRelayE2EEIdentity(dir);
  const challenge = createRelayE2EEChallenge();
  const client = await createRelayE2EEClientHandshake(
    relayE2EEPairingMaterial(identity),
    challenge,
  );
  assert.equal(isRelayE2EEHello(client.hello), true);
  assert.equal(isRelayE2EEHello({ ...client.hello, challenge: `${client.hello.challenge}A` }), false);
  assert.equal(isRelayE2EEHello({ ...client.hello, clientPublicKey: `${client.hello.clientPublicKey}A` }), false);
  assert.equal(isRelayE2EEHello({ ...client.hello, proof: `${client.hello.proof}A` }), false);
  await assert.rejects(
    () => acceptRelayE2EEClientHello(
      identity,
      challenge,
      { ...client.hello, proof: `${client.hello.proof}A` },
    ),
    /authentication failed/,
  );
});

test('rejects a client that does not possess the fragment secret', async () => {
  const firstDir = mkdtempSync(join(tmpdir(), 'mixdog-e2ee-a-'));
  const secondDir = mkdtempSync(join(tmpdir(), 'mixdog-e2ee-b-'));
  const identity = await loadOrCreateRelayE2EEIdentity(firstDir);
  const wrong = await loadOrCreateRelayE2EEIdentity(secondDir);
  const challenge = createRelayE2EEChallenge();
  const client = await createRelayE2EEClientHandshake({
    ...relayE2EEPairingMaterial(identity),
    pairingSecret: wrong.pairingSecret,
  }, challenge);
  await assert.rejects(
    () => acceptRelayE2EEClientHello(identity, challenge, client.hello),
    /authentication failed/,
  );
});

test('persists and rotates identity, keeping browser secret in the fragment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-e2ee-persist-'));
  const first = await loadOrCreateRelayE2EEIdentity(dir);
  assert.deepEqual(await loadOrCreateRelayE2EEIdentity(dir), first);
  const rotated = await rotateRelayE2EEIdentity(dir);
  assert.notEqual(rotated.serverPublicKey, first.serverPublicKey);
  assert.notEqual(rotated.pairingSecret, first.pairingSecret);

  const info = await buildRemoteAccessInfo({
    relay: {
      clientUrl: 'https://relay.example/?token=route',
      token: 'route-token',
      pairing: relayE2EEPairingMaterial(rotated),
    },
  });
  const browser = new URL(info.relayBrowserUrl);
  assert.equal(browser.searchParams.has('e2eeSecret'), false);
  assert.equal(new URLSearchParams(browser.hash.slice(1)).get('e2eeSecret'), rotated.pairingSecret);
});

test('persists and rotates the relay routing token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-token-'));
  const first = await loadOrCreatePairingToken(dir);
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(await loadOrCreatePairingToken(dir), first);
  const rotated = await rotatePairingToken(dir);
  assert.notEqual(rotated, first);
  assert.equal(await loadOrCreatePairingToken(dir), rotated);
});
