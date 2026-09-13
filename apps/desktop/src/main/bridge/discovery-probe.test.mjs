import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createBridgeDiscoveryRecord, probeBridgeDiscovery } from './discovery-ownership.ts';

async function withEndpoint(handler, inspect) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await inspect(createBridgeDiscoveryRecord({
      port: server.address().port, token: 'probe-fixture', generation: 1,
    }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('a health response interrupted after headers settles as inconclusive', { timeout: 5_000 }, async () => {
  await withEndpoint((_request, response) => {
    response.writeHead(200, { 'content-length': '200', 'content-type': 'application/json' });
    response.write('{"ok":true,');
    setImmediate(() => response.destroy());
  }, async record => {
    assert.equal(await probeBridgeDiscovery(record), 'inconclusive');
  });
});

test('health probing is bounded even while response bytes keep arriving', { timeout: 5_000 }, async () => {
  await withEndpoint((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":');
    const trickle = setInterval(() => response.write(' '), 30);
    response.once('close', () => clearInterval(trickle));
  }, async record => {
    assert.equal(await probeBridgeDiscovery(record), 'inconclusive');
  });
});
