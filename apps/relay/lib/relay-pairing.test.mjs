import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  CLAIM_TTL_MS,
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

test('claim GET for an unknown id is expired, not 404', async () => {
  const response = recordingResponse();
  await handleClaimRequest(
    { store: {}, liveDesktops: new Map(), claims: new Map(), unauthorizedLimiter: { allow: () => true } },
    { method: 'GET', url: '/claim/missing', headers: {} },
    response
  );
  assert.equal(response.recorded[0].status, 200);
  assert.deepEqual(JSON.parse(response.recorded[0].body), { status: 'expired' });
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
