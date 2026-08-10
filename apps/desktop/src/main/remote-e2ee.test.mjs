import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import {
  loadOrCreateRelayE2EEIdentity,
  rotateRelayE2EEIdentity,
} from './remote-e2ee';
import { buildRemoteAccessInfo } from './remote-access-window';

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

  const response = await server.encryptJson({ id: 1, ok: true });
  assert.deepEqual(await client.channel.decryptJson(response), { id: 1, ok: true });
  assert.doesNotMatch(request, /listProjects/);
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
    bridge: null,
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
