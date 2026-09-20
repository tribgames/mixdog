import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-hook-tunnel-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;
const { startHookTunnel } = await import('./relay-tunnel.mjs');

test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

async function relayFixture() {
  const relay = http.createServer();
  const wss = new WebSocketServer({ server: relay, path: '/hookleg' });
  const legs = [];
  wss.on('connection', (ws, request) => legs.push({ ws, authorization: request.headers.authorization }));
  const port = await listen(relay);
  return {
    url: `ws://127.0.0.1:${port}`,
    legs,
    nextLeg: async () => {
      if (legs.length) return legs.shift();
      await once(wss, 'connection');
      return legs.shift();
    },
    async roundTrip(ws, frame) {
      const reply = once(ws, 'message');
      ws.send(JSON.stringify(frame));
      const [raw] = await reply;
      return JSON.parse(String(raw));
    },
    async stop() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await close(relay);
    },
  };
}

function httpFrame(id, body = '') {
  return {
    type: 'http',
    id,
    method: 'POST',
    path: '/webhook/demo',
    headers: { 'content-type': 'application/json', 'x-demo': 'yes' },
    body: Buffer.from(body).toString('base64'),
  };
}

test('the tunnel authenticates with the persisted identity and replays frames against the local server', async () => {
  const relay = await relayFixture();
  const received = [];
  const local = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, demo: request.headers['x-demo'], body });
      response.writeHead(201, { 'content-type': 'text/plain' });
      response.end('stored');
    });
  });
  const localPort = await listen(local);
  const tunnel = startHookTunnel({ relayUrl: relay.url, getLocalPort: () => localPort });
  try {
    const identity = JSON.parse(readFileSync(join(dataDir, 'relay-hook-device.json'), 'utf8'));
    assert.equal(tunnel.deviceId, identity.deviceId);
    assert.equal(tunnel.publicBase, `${relay.url.replace('ws://', 'http://')}/hook/${identity.deviceId}`);
    const leg = await relay.nextLeg();
    const expectedAuth = `Basic ${Buffer.from(`${identity.deviceId}:${identity.deviceSecret}`).toString('base64')}`;
    assert.equal(leg.authorization, expectedAuth);

    const reply = await relay.roundTrip(leg.ws, httpFrame('req-1', '{"hello":1}'));
    assert.deepEqual(reply, {
      type: 'http-response',
      id: 'req-1',
      status: 201,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('stored').toString('base64'),
    });
    assert.deepEqual(received, [{ method: 'POST', url: '/webhook/demo', demo: 'yes', body: '{"hello":1}' }]);

    const invalid = await relay.roundTrip(leg.ws, { type: 'http', id: 'bad-1', method: 'GET', path: '/webhook/x' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.id, 'bad-1');
    assert.match(Buffer.from(invalid.body, 'base64').toString(), /method must be POST/);
  } finally {
    tunnel.close();
    await close(local);
    await relay.stop();
  }
});

test('without a local listener the tunnel answers 503, and it reconnects after the relay drops the leg', async () => {
  const relay = await relayFixture();
  const tunnel = startHookTunnel({ relayUrl: relay.url, getLocalPort: () => null });
  try {
    const first = await relay.nextLeg();
    const reply = await relay.roundTrip(first.ws, httpFrame('req-503'));
    assert.equal(reply.status, 503);
    assert.equal(Buffer.from(reply.body, 'base64').toString(), '{"error":"webhook server not listening"}');
    first.ws.close();
    const second = await relay.nextLeg();
    assert.notEqual(second.ws, first.ws, 'a fresh leg is dialed after the close');
  } finally {
    tunnel.close();
    await relay.stop();
  }
});

test('close terminates the leg and stops reconnecting', async () => {
  const relay = await relayFixture();
  const tunnel = startHookTunnel({ relayUrl: relay.url, getLocalPort: () => null });
  const leg = await relay.nextLeg();
  const closed = once(leg.ws, 'close');
  tunnel.close();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(relay.legs.length, 0, 'no reconnect after close');
  await relay.stop();
});
