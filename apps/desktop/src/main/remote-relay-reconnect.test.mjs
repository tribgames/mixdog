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

test('repeated unresponsive-leg closes redial at once only a bounded number of times, then keep the backoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-reconnect-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections = [];
  const connectedAt = [];
  server.on('connection', (socket) => {
    connections.push(socket);
    connectedAt.push(Date.now());
  });
  const waitForConnection = async (count, limitMs) => {
    const started = Date.now();
    while (connections.length < count && Date.now() - started < limitMs) await wait(5);
    assert.equal(connections.length, count, `connection ${count} arrived`);
  };
  let handle;
  try {
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host });
    await waitForConnection(1, 2_000);
    const gaps = [];
    // A relay that keeps judging every leg dead, each one right after it opens.
    for (let index = 1; index <= 4; index++) {
      await wait(50);
      const closedAt = Date.now();
      connections[index - 1].close(4010, 'desktop leg unresponsive');
      await waitForConnection(index + 1, 5_000);
      gaps.push(connectedAt[index] - closedAt);
    }
    assert.ok(gaps[0] < 500 && gaps[1] < 500, `the first two redial at once: ${gaps}`);
    assert.ok(gaps[2] >= 900, `the third waits the backoff: ${gaps}`);
    assert.ok(gaps[3] >= 1_900, `opening a leg is not a recovery; the backoff keeps growing: ${gaps}`);
    // The loop still never stops: the PC keeps redialing on its own.
    assert.equal([...server.clients].filter((client) => client.readyState === 1).length, 1);
  } finally {
    await handle?.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a leg the relay closed for a stalled phone handshake redials at once, then backs off as before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-reconnect-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections = [];
  const connectedAt = [];
  server.on('connection', (socket) => {
    connections.push(socket);
    connectedAt.push(Date.now());
  });
  let handle;
  try {
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host });
    while (connections.length < 1) await wait(10);
    const stalledAt = Date.now();
    connections[0].close(4010, 'phone handshake stalled');
    while (connections.length < 2 && Date.now() - stalledAt < 2_000) await wait(5);
    assert.equal(connections.length, 2, 'the PC redialed');
    // The ordinary backoff starts at a full second; a stalled-handshake close
    // must not wait it out while the phone's own budget runs.
    assert.ok(connectedAt[1] - stalledAt < 500, `redial took ${connectedAt[1] - stalledAt}ms`);
    // Any other close keeps the ordinary backoff.
    const droppedAt = Date.now();
    connections[1].terminate();
    while (connections.length < 3 && Date.now() - droppedAt < 3_000) await wait(10);
    assert.equal(connections.length, 3);
    assert.ok(connectedAt[2] - droppedAt >= 900, 'an ordinary drop still waits its backoff');
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
