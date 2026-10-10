// Pairing approval and the E2EE handshake: an approval mints the credential,
// and the handshake tells the connection the host serves it open access.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRelayE2EEClientHandshake,
  generateRelayClaimKeyPair,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee.ts';
import { MIXDOG_DESKTOP_CLIENT_BROWSER } from '../shared/remote-trust.ts';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle.ts';
import { createRelayClientRegistry } from './remote-relay-clients.ts';

const CREDENTIAL = '0123456789abcdef0123456789abcdef';

async function harness({ decision } = {}) {
  const identity = await generateRelayE2EEServerIdentity();
  const pairing = relayE2EEPairingMaterial(identity);
  const envelopes = [];
  const frames = [];
  const claims = [];
  const clients = createRelayClientRegistry({
    host: { setVisibleSessionsForSource: async () => true },
    sendEnvelope: (payload) => envelopes.push(payload),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
  });
  const lifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity: identity,
    pairing,
    relayBinaryFrames: () => false,
    viewSyncSupported: () => false,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => envelopes.push(payload),
    sendEncryptedFrame: async (clientId, payload) => {
      frames.push({ clientId, payload });
    },
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
    onClientClaim: async (claim) => {
      claims.push(claim);
      return decision ?? { approved: true };
    },
  });
  return { identity, pairing, envelopes, frames, claims, clients, lifecycle };
}

async function claimEnvelope(overrides = {}) {
  const { publicKey } = await generateRelayClaimKeyPair();
  return { claimId: 'claim-1', clientId: CREDENTIAL, publicKey, name: 'Laptop', browser: 'Chrome', ...overrides };
}

const answered = async (envelopes, type) => {
  for (let attempt = 0; attempt < 200 && !envelopes.some((entry) => entry.type === type); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return envelopes.find((entry) => entry.type === type);
};

test('an approval returns the sealed credential box', async () => {
  const h = await harness();
  h.lifecycle.answerClaim(await claimEnvelope());
  const approve = await answered(h.envelopes, 'claim-approve');
  assert.ok(approve?.sealed, 'a sealed credential box is returned');
});

test('a denial grants nothing', async () => {
  const denied = await harness({ decision: { approved: false } });
  denied.lifecycle.answerClaim(await claimEnvelope());
  assert.ok(await answered(denied.envelopes, 'claim-deny'));
  assert.equal(
    denied.envelopes.some((entry) => entry.type === 'claim-approve'),
    false
  );
});

test('a Mixdog desktop window is labelled as one; the label grants nothing extra', async () => {
  const h = await harness();
  h.lifecycle.answerClaim(await claimEnvelope({ browser: MIXDOG_DESKTOP_CLIENT_BROWSER }));
  h.lifecycle.answerClaim(await claimEnvelope({ claimId: 'claim-2', clientId: 'b'.repeat(32), browser: 'Chrome' }));
  await answered(h.envelopes, 'claim-approve');
  assert.equal(h.claims[0].desktop, true);
  assert.equal(h.claims[1].desktop, false);
});

async function handshake(h, credentialId) {
  h.lifecycle.open('route-1', credentialId);
  const challenge = JSON.parse(h.envelopes.find((entry) => entry.type === 'frame').data);
  const { hello } = await createRelayE2EEClientHandshake(h.pairing, challenge);
  h.lifecycle.receive('route-1', h.clients.get('route-1'), JSON.stringify(hello));
  for (let attempt = 0; attempt < 200 && !h.frames.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return h.frames[0].payload;
}

test('the handshake announces open access and carries no trust field', async () => {
  const h = await harness();
  const ready = await handshake(h, CREDENTIAL);
  assert.equal(ready.type, 'e2ee-ready');
  assert.equal(ready.remoteOpenAccess, 1);
  assert.equal('trusted' in ready, false);
  assert.equal(h.clients.get('route-1').credentialId, CREDENTIAL);
});
