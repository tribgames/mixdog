import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { waitUntil } from './bounded-wait.mjs';
import { createNativePushStore } from './native-push-store.ts';
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

async function withLeg(options, run, prepare = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-routing-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  let handle;
  try {
    await prepare(dir);
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`,
      userDataPath: dir,
      host,
      ...options,
    });
    const [socket] = await connected;
    const frames = [];
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    await waitUntil(() => frames.some((frame) => frame.type === 'set-client-token'), 'the open handshake');
    await run({ socket, frames, dir });
  } finally {
    await handle?.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('media envelopes reach the media lane with their defaults; one without an id is ignored', async () => {
  const calls = [];
  const lane = {
    serve: async (request) => {
      calls.push(['serve', request]);
    },
    abort: (id) => calls.push(['abort', id]),
    setPaused: (id, paused) => calls.push(['setPaused', id, paused]),
    destroyAll: () => {},
  };
  await withLeg({ createMediaLane: () => lane }, async ({ socket }) => {
    socket.send(JSON.stringify({ type: 'media-abort' }));
    socket.send(JSON.stringify({ type: 'media-request', id: 'm1' }));
    socket.send(
      JSON.stringify({
        type: 'media-request',
        id: 'm2',
        assetId: 'a',
        variant: 'thumb',
        method: 'HEAD',
        range: 'bytes=0-1',
        sid: 's',
        enc: 'e',
      })
    );
    socket.send(JSON.stringify({ type: 'media-pause', id: 'm1' }));
    socket.send(JSON.stringify({ type: 'media-resume', id: 'm1' }));
    socket.send(JSON.stringify({ type: 'media-abort', id: 'm2' }));
    await waitUntil(() => calls.length >= 5, 'every media envelope routed');
    assert.deepEqual(calls, [
      ['serve', { id: 'm1', assetId: '', variant: 'original', method: 'GET', range: '', sid: '', enc: '' }],
      ['serve', { id: 'm2', assetId: 'a', variant: 'thumb', method: 'HEAD', range: 'bytes=0-1', sid: 's', enc: 'e' }],
      ['setPaused', 'm1', true],
      ['setPaused', 'm1', false],
      ['abort', 'm2'],
    ]);
  });
});

test('a relay that can deliver native push gets every stored token bound; a dead token is dropped', async () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const token = 'cd'.repeat(32);
  await withLeg(
    {},
    async ({ socket, frames, dir }) => {
      // Not deliverable on this connection yet: nothing is bound.
      assert.equal(
        frames.some((frame) => frame.type === 'native-push-bind'),
        false
      );
      socket.send(JSON.stringify({ type: 'relay-capabilities', nativePush: 1, nativePushPlatforms: ['apns'] }));
      await waitUntil(() => frames.some((frame) => frame.type === 'native-push-bind'), 'the stored token bound');
      assert.deepEqual(
        frames.filter((frame) => frame.type === 'native-push-bind'),
        [{ type: 'native-push-bind', clientId: 'c1', platform: 'apns', token }]
      );
      socket.send(JSON.stringify({ type: 'native-push-result', invalid: true, token }));
      let rows = 1;
      for (let attempt = 0; attempt < 250 && rows > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rows = (await createNativePushStore(dir).list()).length;
      }
      assert.equal(rows, 0, 'the dead token removed');
    },
    async (dir) => {
      await createNativePushStore(dir).register({
        clientId: 'c1',
        platform: 'apns',
        token,
        publicKey: ecdh.getPublicKey().toString('base64url'),
      });
    }
  );
});
