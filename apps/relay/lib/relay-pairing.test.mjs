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

function mockResponse() {
  const recorded = [];
  return {
    recorded,
    writeHead(status, headers) {
      recorded.push({ status, headers });
      return this;
    },
    end(body) {
      recorded.at(-1).body = body;
    },
  };
}

test('pending claim pool bounds are the ones the HTTP handler enforces', () => {
  assert.equal(MAX_PENDING_CLAIMS, 64);
  assert.equal(MAX_PENDING_CLAIMS_PER_DEVICE, 8);
  assert.equal(MAX_PENDING_CLAIMS_PER_SOURCE, 8);
  assert.equal(CLAIM_TTL_MS, 300_000);
});

test('client registration refuses non-POST and cross-origin callers', async () => {
  const response = mockResponse();
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
  const response = mockResponse();
  await handleClaimRequest(
    { store: {}, liveDesktops: new Map(), claims: new Map(), unauthorizedLimiter: { allow: () => true } },
    { method: 'GET', url: '/claim/missing', headers: {} },
    response
  );
  assert.equal(response.recorded[0].status, 200);
  assert.deepEqual(JSON.parse(response.recorded[0].body), { status: 'expired' });
});

test('claim POST for an unknown desktop is refused with 404', async () => {
  const request = new EventEmitter();
  request.method = 'POST';
  request.url = '/claim';
  request.headers = { origin: 'https://relay.example', host: 'relay.example' };
  request.socket = { encrypted: true };
  queueMicrotask(() => {
    request.emit('data', Buffer.from(JSON.stringify({ deviceId: 'nope', clientId: 'nope', publicKey: 'x' })));
    request.emit('end');
  });
  const response = mockResponse();
  await handleClaimRequest(
    {
      store: { isKnown: () => false },
      liveDesktops: new Map(),
      claims: new Map(),
      unauthorizedLimiter: { allow: () => true },
    },
    request,
    response
  );
  assert.equal(response.recorded[0].status, 404);
});
