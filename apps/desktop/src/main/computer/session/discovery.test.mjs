import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBridgeDiscovery } from './discovery.ts';
import {
  bridgeDiscoveryPublicIdentity,
  createBridgeDiscoveryRecord,
} from './discovery-ownership.ts';

async function temporaryDirectory() {
  return await mkdtemp(join(tmpdir(), 'mixdog-computer-discovery-'));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function readDiscovery(directory) {
  return JSON.parse(await readFile(join(directory, 'computer-bridge.json'), 'utf8'));
}

test('Computer Use discovery preserves a live foreign owner', async () => {
  const directory = await temporaryDirectory();
  const token = 'foreign-live-token';
  let foreign;
  const server = createServer((request, response) => {
    if (request.url !== '/health'
      || request.headers.authorization !== `Bearer ${token}`
      || !foreign) {
      response.writeHead(401);
      response.end();
      return;
    }
    const body = JSON.stringify({
      ok: true,
      identity: bridgeDiscoveryPublicIdentity(foreign),
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  try {
    const port = await listen(server);
    foreign = createBridgeDiscoveryRecord({
      port,
      token,
      pid: 2001,
      generation: 7,
      startedAt: 7000,
    });
    await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify(foreign)}\n`);
    const own = createBridgeDiscoveryRecord({
      port: port === 65_535 ? port - 1 : port + 1,
      token: 'own-token',
      pid: 2002,
      generation: 8,
      startedAt: 8000,
    });
    const discovery = createBridgeDiscovery({ dataDirectory: () => directory });
    assert.equal(await discovery.writeDiscovery(own), 'occupied');
    assert.deepEqual(await readDiscovery(directory), foreign);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use discovery reclaims one stable dead foreign owner', async () => {
  const directory = await temporaryDirectory();
  const server = createServer();
  try {
    const deadPort = await listen(server);
    await close(server);
    const foreign = createBridgeDiscoveryRecord({
      port: deadPort,
      token: 'foreign-dead-token',
      pid: 3001,
      generation: 2,
      startedAt: 2000,
    });
    const own = createBridgeDiscoveryRecord({
      port: deadPort === 65_535 ? deadPort - 1 : deadPort + 1,
      token: 'own-token',
      pid: 3002,
      generation: 3,
      startedAt: 3000,
    });
    await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify(foreign)}\n`);
    const discovery = createBridgeDiscovery({ dataDirectory: () => directory });
    assert.equal(await discovery.writeDiscovery(own), 'owned');
    assert.deepEqual(await readDiscovery(directory), own);
  } finally {
    if (server.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use discovery does not overwrite an identity that changes during a dead probe', async () => {
  const directory = await temporaryDirectory();
  try {
    const foreign = createBridgeDiscoveryRecord({
      port: 41001,
      token: 'foreign-old-token',
      pid: 4001,
      generation: 1,
      startedAt: 1000,
    });
    const replacement = createBridgeDiscoveryRecord({
      port: 41002,
      token: 'foreign-new-token',
      pid: 4002,
      generation: 2,
      startedAt: 2000,
    });
    const own = createBridgeDiscoveryRecord({
      port: 41003,
      token: 'own-token',
      pid: 4003,
      generation: 3,
      startedAt: 3000,
    });
    await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify(foreign)}\n`);
    const discovery = createBridgeDiscovery({
      dataDirectory: () => directory,
      probeDiscovery: async () => {
        await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify(replacement)}\n`);
        return 'dead';
      },
    });
    assert.equal(await discovery.writeDiscovery(own), 'inconclusive');
    assert.deepEqual(await readDiscovery(directory), replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Computer Use discovery isolates stale generations and reports own endpoint loss', async () => {
  const directory = await temporaryDirectory();
  try {
    let probeOutcome = 'dead';
    const discovery = createBridgeDiscovery({
      dataDirectory: () => directory,
      probeDiscovery: async () => probeOutcome,
    });
    const first = createBridgeDiscoveryRecord({
      port: 42001,
      token: 'first-token',
      pid: 5001,
      generation: 1,
      startedAt: 1000,
    });
    const second = createBridgeDiscoveryRecord({
      port: 42002,
      token: 'second-token',
      pid: 5001,
      generation: 2,
      startedAt: 2000,
    });
    assert.equal(await discovery.writeDiscovery(first), 'owned');
    assert.equal(await discovery.writeDiscovery(second), 'owned');
    assert.equal(await discovery.heartbeatDiscovery(first), 'superseded');
    discovery.removeDiscovery(first);
    assert.deepEqual(await readDiscovery(directory), second);
    probeOutcome = 'dead';
    assert.equal(await discovery.heartbeatDiscovery(second), 'lost');
    discovery.removeDiscovery(second);
    await assert.rejects(readDiscovery(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
