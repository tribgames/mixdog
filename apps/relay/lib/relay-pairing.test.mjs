import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  APPROVED_CLAIM_RETAIN_MS,
  CLAIM_TTL_MS,
  EXPIRED_CLAIM_RETAIN_MS,
  MAX_PENDING_CLAIMS,
  MAX_PENDING_CLAIMS_PER_DEVICE,
  MAX_PENDING_CLAIMS_PER_SOURCE,
  handleClaimRequest,
  handleClientRegistration,
} from './relay-pairing.mjs';
import { recordingResponse } from './test-recording-response.mjs';

test('pending claim pool bounds are the ones the HTTP handler enforces', () => {
  assert.equal(MAX_PENDING_CLAIMS, 64);
  assert.equal(MAX_PENDING_CLAIMS_PER_DEVICE, 8);
  assert.equal(MAX_PENDING_CLAIMS_PER_SOURCE, 8);
  assert.equal(CLAIM_TTL_MS, 300_000);
});

test('client registration refuses non-POST and cross-origin callers', async () => {
  const response = recordingResponse();
  await handleClientRegistration({}, { allow: () => true }, { method: 'GET', headers: {}, socket: {} }, response);
  assert.equal(response.recorded[0].status, 405);
  await handleClientRegistration(
    {},
    { allow: () => true },
    { method: 'POST', headers: { origin: 'https://evil.example', host: 'relay.example' }, socket: { encrypted: true } },
    response
  );
  assert.equal(response.recorded[1].status, 403);
});

async function pollClaim(claims, claimId) {
  const response = recordingResponse();
  await handleClaimRequest(
    { store: {}, liveDesktops: new Map(), claims, unauthorizedLimiter: { allow: () => true } },
    { method: 'GET', url: `/claim/${claimId}`, headers: {} },
    response
  );
  assert.equal(response.recorded[0].status, 200);
  return JSON.parse(response.recorded[0].body);
}

test('claim GET for an id this relay does not hold is unknown, not expired or 404', async () => {
  assert.deepEqual(await pollClaim(new Map(), 'missing'), { status: 'unknown' });
});

function claimRecord(overrides) {
  return {
    id: 'c1',
    deviceId: 'dev',
    clientId: 'bbbbbbbb',
    status: 'approved',
    token: 'a'.repeat(64),
    sealed: { box: 'opaque' },
    expiresAt: Date.now() + APPROVED_CLAIM_RETAIN_MS,
    ...overrides,
  };
}

test('an approved claim can be read again until its retention ends, then it is unknown', async (t) => {
  const claim = claimRecord();
  const claims = new Map([[claim.id, claim]]);
  const approved = { status: 'approved', clientId: 'bbbbbbbb', token: claim.token, sealed: { box: 'opaque' } };
  assert.deepEqual(await pollClaim(claims, 'c1'), approved);
  assert.deepEqual(await pollClaim(claims, 'c1'), approved, 'a lost answer can be asked for again');
  // Another claim id is not this claim: no credential for a guess.
  assert.deepEqual(await pollClaim(claims, 'c2'), { status: 'unknown' });
  t.mock.method(Date, 'now', () => claim.expiresAt + 1);
  assert.deepEqual(await pollClaim(claims, 'c1'), { status: 'unknown' });
  assert.equal(claims.size, 0);
});

test('a lapsed pending claim answers expired for a while, then unknown', async (t) => {
  const claim = claimRecord({ status: 'pending', token: '', sealed: null, expiresAt: Date.now() - 1 });
  const claims = new Map([[claim.id, claim]]);
  assert.deepEqual(await pollClaim(claims, 'c1'), { status: 'expired' });
  assert.deepEqual(await pollClaim(claims, 'c1'), { status: 'expired' });
  t.mock.method(Date, 'now', () => claim.expiresAt + EXPIRED_CLAIM_RETAIN_MS + 10);
  assert.deepEqual(await pollClaim(claims, 'c1'), { status: 'unknown' });
});

test('registering with the claim credential ends the re-read window', async () => {
  const claim = claimRecord();
  const other = claimRecord({ id: 'c2', token: 'b'.repeat(64) });
  const claims = new Map([
    [claim.id, claim],
    [other.id, other],
  ]);
  const store = {
    clientAccessForToken: (token) => (token === claim.token ? { deviceId: 'dev', clientId: 'bbbbbbbb' } : null),
    touchClient() {},
  };
  const response = recordingResponse();
  const request = new EventEmitter();
  request.method = 'POST';
  request.url = '/client/register';
  request.headers = { origin: 'https://relay.example', host: 'relay.example', authorization: `Bearer ${claim.token}` };
  request.socket = { encrypted: true };
  queueMicrotask(() => {
    request.emit('data', Buffer.from(JSON.stringify({ clientId: 'bbbbbbbb' })));
    request.emit('end');
  });
  await handleClientRegistration(store, { allow: () => true }, request, response, claims);
  assert.equal(response.recorded[0].status, 200);
  assert.deepEqual([...claims.keys()], ['c2']);
});

test('claim POST refuses malformed fields before lookup and unknown desktops after lookup', async () => {
  const deviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  for (const [body, expectedChecks] of [
    [{ deviceId: 'nope', clientId: 'nope', publicKey: 'x' }, []],
    [{ deviceId, clientId: 'bbbbbbbb', publicKey: 'A'.repeat(86) }, [deviceId]],
  ]) {
    const request = new EventEmitter();
    request.method = 'POST';
    request.url = '/claim';
    request.headers = { origin: 'https://relay.example', host: 'relay.example' };
    request.socket = { encrypted: true };
    queueMicrotask(() => {
      request.emit('data', Buffer.from(JSON.stringify(body)));
      request.emit('end');
    });
    const checkedDevices = [];
    const response = recordingResponse();
    await handleClaimRequest(
      {
        store: {
          isKnown(id) {
            checkedDevices.push(id);
            return false;
          },
        },
        liveDesktops: new Map(),
        claims: new Map(),
        unauthorizedLimiter: { allow: () => true },
      },
      request,
      response
    );
    assert.equal(response.recorded[0].status, 404);
    assert.deepEqual(checkedDevices, expectedChecks);
  }
});
