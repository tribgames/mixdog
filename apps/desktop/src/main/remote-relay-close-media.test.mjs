import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { waitUntil } from './bounded-wait.mjs';
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

test('explicit close() destroys in-flight media streams', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-close-media-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let connected = 0;
  let destroyed = 0;
  server.on('connection', () => {
    connected += 1;
  });
  try {
    const handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`,
      userDataPath: dir,
      host,
      onConnected: () => {},
      createMediaLane: () => ({
        serve: async () => {},
        abort: () => {},
        setPaused: () => {},
        destroyAll: () => {
          destroyed += 1;
        },
      }),
    });
    while (connected < 1) await wait(10);
    await handle.close();
    await waitUntil(() => destroyed >= 1, 'mediaLane.destroyAll after the explicit close');
    assert.ok(destroyed >= 1, 'mediaLane.destroyAll ran on explicit close');
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
