import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { startRemoteRelay } from './remote-relay.ts';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => () => {};
const host = {
  getSnapshot: () => ({ sessionId: 's', items: [], status: 'idle' }),
  listSessions: async () => [],
  listAgentPool: async () => [],
  subscribe: noop,
  subscribeSessions: noop,
  subscribeAgentPool: noop,
  subscribeSessionStates: noop,
  subscribeDesktopEvents: noop,
  setVisibleSessionsForSource: async () => true,
  invokeDesktopOperation: async () => null,
};

test('disconnect + resume + network change leave exactly one live relay connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-reconnect-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections = [];
  server.on('connection', (socket) => connections.push(socket));
  let handle;
  try {
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host });
    while (connections.length < 1) await wait(10);
    // The relay drops the leg; the desktop notices and arms its backoff timer.
    connections[0].terminate();
    await wait(150);
    // System resume, then the network watcher firing right behind it.
    handle.resume();
    handle.resume();
    await wait(2_500);
    assert.equal(connections.length, 2, 'one reconnect, no storm');
    assert.equal([...server.clients].filter((client) => client.readyState === 1).length, 1);
  } finally {
    await handle?.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a closed superseded socket does not schedule another connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-reconnect-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections = [];
  server.on('connection', (socket) => connections.push(socket));
  let handle;
  try {
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host });
    while (connections.length < 1) await wait(10);
    // Resume on a healthy leg terminates it once; the single close redials once.
    handle.resume();
    handle.resume();
    await wait(2_500);
    assert.equal(connections.length, 2);
    assert.equal([...server.clients].filter((client) => client.readyState === 1).length, 1);
  } finally {
    await handle?.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
