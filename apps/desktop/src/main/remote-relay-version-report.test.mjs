import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startRemoteRelay } from './remote-relay.ts';

const none = () => () => {};
const host = {
  getSnapshot: () => ({ sessionId: 'session', items: [], status: 'idle' }),
  listSessions: async () => [],
  listAgentPool: async () => [],
  subscribe: none,
  subscribeSessions: none,
  subscribeAgentPool: none,
  subscribeSessionStates: none,
  subscribeDesktopEvents: none,
  setVisibleSessionsForSource: async () => true,
  invokeDesktopOperation: async () => null,
};

async function leg(options) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-version-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  let handle;
  try {
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`,
      userDataPath: dir,
      host,
      ...options,
    });
    const [socket] = await connected;
    const frames = [];
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    // set-client-token is the last frame of the open handshake.
    while (!frames.some((frame) => frame.type === 'set-client-token')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return frames;
  } finally {
    await handle?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('the device leg reports the desktop build before it registers its token', async () => {
  const frames = await leg({ appVersion: '1.2.3', rendererRelease: 'a'.repeat(64) });
  const types = frames.map((frame) => frame.type);
  assert.deepEqual(types, ['desktop-lanes', 'desktop-version', 'set-client-token']);
  assert.deepEqual(frames[1], { type: 'desktop-version', appVersion: '1.2.3', rendererRelease: 'a'.repeat(64) });
});

test('a build that cannot name its version sends no report (relay treats it as legacy)', async () => {
  const frames = await leg({});
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['desktop-lanes', 'set-client-token']
  );
});
