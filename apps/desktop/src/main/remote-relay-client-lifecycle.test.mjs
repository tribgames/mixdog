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

async function harness({ decision, hostName, hold = false, joinFrames } = {}) {
  const identity = await generateRelayE2EEServerIdentity();
  const pairing = relayE2EEPairingMaterial(identity);
  const envelopes = [];
  const frames = [];
  const claims = [];
  // `hold` keeps each claim pending like an open approval dialog; the user's
  // answer is `settle`, and a conflict settles it as denied like the arbiter.
  const settlers = new Map();
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
    joinFrames,
    hostName,
    onClientClaim: (claim) => {
      claims.push(claim);
      if (!hold) return Promise.resolve(decision ?? { approved: true });
      return new Promise((resolve) => settlers.set(claim.claimId, resolve));
    },
    onClaimConflict: (claimId) => settlers.get(claimId)?.({ approved: false }),
  });
  const settle = (claimId, approved) => settlers.get(claimId)?.({ approved });
  return { identity, pairing, envelopes, frames, claims, clients, lifecycle, settle };
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

const settled = () => new Promise((resolve) => setTimeout(resolve, 40));
const sentFor = (h, claimId) =>
  h.envelopes.filter(
    (entry) => (entry.type === 'claim-approve' || entry.type === 'claim-deny') && entry.claimId === claimId
  );

test('a redelivery with the same key shares the decision and seals once', async () => {
  const h = await harness({ hold: true });
  const envelope = await claimEnvelope();
  h.lifecycle.answerClaim(envelope);
  h.lifecycle.answerClaim({ ...envelope });
  await settled();
  h.settle('claim-1', true);
  await answered(h.envelopes, 'claim-approve');
  h.lifecycle.answerClaim({ ...envelope });
  await settled();
  const sent = sentFor(h, 'claim-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'claim-approve');
  assert.equal(h.claims.length, 1);
});

test('a redelivery with a different key is denied and denies the original claim too', async () => {
  const h = await harness({ hold: true });
  const envelope = await claimEnvelope();
  h.lifecycle.answerClaim(envelope);
  h.lifecycle.answerClaim(await claimEnvelope());
  await settled();
  // The user's Allow arrives after the conflict: neither key is sealed.
  h.settle('claim-1', true);
  await settled();
  assert.equal(
    h.envelopes.some((entry) => entry.type === 'claim-approve'),
    false
  );
  assert.ok(sentFor(h, 'claim-1').length >= 1);
  assert.ok(sentFor(h, 'claim-1').every((entry) => entry.type === 'claim-deny'));
});

test('a redelivery with another client id is a conflict as well', async () => {
  const h = await harness({ hold: true });
  const envelope = await claimEnvelope();
  h.lifecycle.answerClaim(envelope);
  h.lifecycle.answerClaim({ ...envelope, clientId: 'c'.repeat(32) });
  await settled();
  h.settle('claim-1', true);
  await settled();
  assert.equal(
    h.envelopes.some((entry) => entry.type === 'claim-approve'),
    false
  );
});

test('a different key arriving after the approval was sent changes nothing already sent', async () => {
  const h = await harness({ hold: true });
  const envelope = await claimEnvelope();
  h.lifecycle.answerClaim(envelope);
  await settled();
  h.settle('claim-1', true);
  await answered(h.envelopes, 'claim-approve');
  h.lifecycle.answerClaim(await claimEnvelope());
  await settled();
  assert.equal(h.envelopes.filter((entry) => entry.type === 'claim-approve').length, 1);
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
  const client = h.clients.get('route-1');
  h.lifecycle.receive('route-1', client, JSON.stringify(hello));
  await client.frameQueue;
  return h.frames[0].payload;
}

test('a hello for a previous PC leg challenge is ignored, never treated as a failed pairing', async () => {
  const h = await harness();
  h.lifecycle.open('route-1', CREDENTIAL);
  // The phone answered the challenge of the leg this one replaced.
  const { createRelayE2EEChallenge } = await import('../shared/remote-e2ee.ts');
  const { hello: stale } = await createRelayE2EEClientHandshake(h.pairing, createRelayE2EEChallenge());
  h.lifecycle.receive('route-1', h.clients.get('route-1'), JSON.stringify(stale));
  await settled();
  assert.equal(
    h.envelopes.some((entry) => entry.type === 'close-client'),
    false,
    'no close the phone would read as a revoked pairing'
  );
  // Its hello for THIS leg's challenge then completes the handshake.
  const challenge = JSON.parse(h.envelopes.find((entry) => entry.type === 'frame').data);
  const { hello } = await createRelayE2EEClientHandshake(h.pairing, challenge);
  h.lifecycle.receive('route-1', h.clients.get('route-1'), JSON.stringify(hello));
  for (let attempt = 0; attempt < 200 && !h.frames.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(h.frames[0]?.payload.type, 'e2ee-ready');
});

test('each handshake is followed by the current join frames (the browser-approval marks baseline)', async () => {
  let current = ['sess_a'];
  const h = await harness({ joinFrames: () => [{ event: 'browserApprovalSessions', payload: current }] });
  await handshake(h, CREDENTIAL);
  assert.deepEqual(
    h.frames.map((frame) => frame.payload.type ?? frame.payload.event),
    ['e2ee-ready', 'browserApprovalSessions']
  );
  assert.deepEqual(h.frames[1].payload.payload, ['sess_a']);
  // A later connection gets the list as it is then.
  current = [];
  h.frames.length = 0;
  h.envelopes.length = 0;
  h.lifecycle.open('route-2', CREDENTIAL);
  const challenge = JSON.parse(h.envelopes.find((entry) => entry.type === 'frame').data);
  const { hello } = await createRelayE2EEClientHandshake(h.pairing, challenge);
  const second = h.clients.get('route-2');
  h.lifecycle.receive('route-2', second, JSON.stringify(hello));
  await second.frameQueue;
  assert.deepEqual(h.frames.at(-1).payload, { event: 'browserApprovalSessions', payload: [] });
});

test('the handshake carries the saved PC name', async () => {
  const h = await harness({ hostName: () => 'Studio PC' });
  assert.equal((await handshake(h, CREDENTIAL)).hostName, 'Studio PC');
});

test('the handshake announces open access and carries no trust field', async () => {
  const h = await harness();
  const ready = await handshake(h, CREDENTIAL);
  assert.equal(ready.type, 'e2ee-ready');
  assert.equal(ready.remoteOpenAccess, 1);
  assert.equal(typeof ready.hostName, 'string');
  assert.ok(ready.hostName.length > 0);
  assert.equal('trusted' in ready, false);
  assert.equal(h.clients.get('route-1').credentialId, CREDENTIAL);
});
