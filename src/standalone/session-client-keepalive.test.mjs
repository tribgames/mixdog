import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { probeSessionHealth } from './session-client.mjs';

// The daemon's server closes idle keep-alive sockets after 5 s; a request the
// client writes to a pooled socket at that moment fails ECONNRESET. The client
// must drop an idle socket first, so the next call opens a fresh one.
// The idle bound comes from the server's advertised `Keep-Alive: timeout=N`, not
// from a number baked into the client: a server whose window is 2 s must have
// its idle socket dropped well before a 4 s bound would.
test('the idle socket bound follows the server\'s advertised keep-alive', async (t) => {
  let connections = 0;
  const server = http.createServer({ keepAliveTimeout: 2_000 }, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();

  assert.ok(await probeSessionHealth({ port, token: 't' }));
  await delay(1_500);
  assert.ok(await probeSessionHealth({ port, token: 't' }));
  assert.equal(connections, 2, 'the pooled socket was dropped inside the server\'s shorter window');
});

test('a call after the daemon keep-alive idle window uses a fresh socket, not one the server is closing', async (t) => {
  let connections = 0;
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();

  assert.ok(await probeSessionHealth({ port, token: 't' }));
  await delay(4_500);
  assert.ok(await probeSessionHealth({ port, token: 't' }));
  assert.equal(connections, 2, 'the idle pooled socket was dropped before the server would close it');
});
