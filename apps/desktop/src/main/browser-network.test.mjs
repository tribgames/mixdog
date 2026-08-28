import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserNetworkLedger } from './browser-network.ts';

test('browser network ledger records request, response, timing, and filters', () => {
  const ledger = new BrowserNetworkLedger();
  const request = ledger.requestWillBeSent({
    requestId: '10.1',
    type: 'Fetch',
    request: {
      method: 'POST',
      url: 'https://example.test/api/items',
      headers: { 'content-type': 'application/json' },
      postData: '{"name":"demo"}',
      hasPostData: true,
    },
  }, undefined, 1_000);
  assert.equal(request.id, 'r1');
  ledger.responseReceived({
    requestId: '10.1',
    type: 'Fetch',
    response: {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      mimeType: 'application/json',
      protocol: 'h2',
    },
  });
  ledger.loadingFinished({ requestId: '10.1', encodedDataLength: 123 }, undefined, 1_075);

  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.get('r1').status, 201);
  assert.equal(ledger.get('r1').finishedAt, 1_075);
  assert.deepEqual(
    ledger.list({ query: 'items', resourceTypes: ['fetch'] }).requests.map((entry) => entry.id),
    ['r1'],
  );
  assert.equal(ledger.list({ resourceTypes: ['image'] }).total, 0);
});

test('browser network ledger keeps redirect hops distinct and records failures', () => {
  const ledger = new BrowserNetworkLedger();
  ledger.requestWillBeSent({
    requestId: '20.1',
    type: 'Document',
    request: { method: 'GET', url: 'https://example.test/old', headers: {} },
  }, 'frame', 2_000);
  ledger.requestWillBeSent({
    requestId: '20.1',
    type: 'Document',
    redirectResponse: {
      status: 302,
      statusText: 'Found',
      headers: { location: '/new' },
    },
    request: { method: 'GET', url: 'https://example.test/new', headers: {} },
  }, 'frame', 2_010);
  ledger.loadingFailed({
    requestId: '20.1',
    errorText: 'net::ERR_FAILED',
  }, 'frame', 2_020);

  assert.equal(ledger.get('r1').status, 302);
  assert.equal(ledger.get('r1').redirectedTo, 'https://example.test/new');
  assert.equal(ledger.get('r2').failure, 'net::ERR_FAILED');
  assert.deepEqual(ledger.list().requests.map((entry) => entry.id), ['r2', 'r1']);
});

test('browser network ledger reconciles a completed main document when CDP omits loadingFinished', () => {
  const ledger = new BrowserNetworkLedger();
  ledger.requestWillBeSent({
    requestId: '25.1',
    type: 'Document',
    request: { method: 'GET', url: 'https://example.test/page#old', headers: {} },
  }, undefined, 2_500);
  ledger.responseReceived({
    requestId: '25.1',
    type: 'Document',
    response: { status: 200, mimeType: 'text/html', headers: {} },
  });

  assert.equal(ledger.pendingCount, 1);
  assert.equal(ledger.finishDocument('https://example.test/page#new', 2_550), 1);
  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.get('r1').finishedAt, 2_550);
});

test('browser network ledger records WebSocket handshakes and frames', () => {
  const ledger = new BrowserNetworkLedger();
  const socket = ledger.webSocketCreated({
    requestId: '30.1',
    url: 'wss://example.test/socket',
  }, undefined, 3_000);
  ledger.webSocketHandshakeResponse({
    requestId: '30.1',
    response: { status: 101, statusText: 'Switching Protocols', headers: {} },
  });
  ledger.webSocketFrame({
    requestId: '30.1',
    response: { opcode: 1, payloadData: 'hello server' },
  }, 'sent', undefined, 3_010);
  ledger.webSocketFrame({
    requestId: '30.1',
    response: { opcode: 1, payloadData: 'hello client' },
  }, 'received', undefined, 3_020);
  ledger.webSocketClosed({ requestId: '30.1' }, undefined, 3_030);

  assert.equal(socket.resourceType, 'websocket');
  assert.equal(socket.status, 101);
  assert.deepEqual(socket.webSocketFrames.map((frame) => frame.direction), ['sent', 'received']);
  assert.equal(socket.finishedAt, 3_030);
});
