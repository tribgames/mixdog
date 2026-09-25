import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startRemoteRelay } from './remote-relay.ts';
import { createRelayE2EEClientHandshake } from '../shared/remote-e2ee.ts';

test('a phone that echoes transcriptPaging opens tail windows; an older build keeps the legacy page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-paging-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const registrations = [];
  const host = {
    getSnapshot: () => null,
    listSessions: async () => [],
    listAgentPool: async () => [],
    subscribe: () => () => {},
    subscribeSessions: () => () => {},
    subscribeAgentPool: () => () => {},
    subscribeSessionStates: () => () => {},
    subscribeDesktopEvents: () => () => {},
    setVisibleSessionsForSource: async (source, ids, legacyTranscript) => {
      registrations.push({ source, ids, legacyTranscript });
      return true;
    },
  };
  let handle;
  let socket;
  const peers = new Map();
  try {
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host });
    [socket] = await connected;
    socket.on('message', (raw) => {
      const envelope = JSON.parse(String(raw));
      const peer = peers.get(envelope.clientId);
      if (envelope.type !== 'frame' || !peer) return;
      peer.queue = peer.queue.then(async () => {
        if (!peer.channel) {
          const challenge = JSON.parse(envelope.data);
          assert.equal(challenge.transcriptPaging, 1, 'the desktop offers transcript paging');
          const handshake = await createRelayE2EEClientHandshake(handle.pairing, challenge);
          const hello = { ...handshake.hello };
          // An older phone build never echoes a flag it does not know.
          if (peer.legacy) delete hello.transcriptPaging;
          else assert.equal(hello.transcriptPaging, 1);
          peer.channel = handshake.channel;
          socket.send(JSON.stringify({ type: 'frame', clientId: peer.id, data: JSON.stringify(hello) }));
          return;
        }
        const message = await peer.channel.decryptJson(envelope.data);
        peer.messages.push(message);
        for (const listener of [...peer.listeners]) listener();
      });
    });
    const waitFor = (peer, match) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No encrypted response within 5s.')), 5000);
        const check = () => {
          const message = peer.messages.find(match);
          if (!message) return;
          clearTimeout(timer);
          peer.listeners.delete(check);
          resolve(message);
        };
        peer.listeners.add(check);
        check();
      });
    const open = async (id, legacy) => {
      const peer = { id, legacy, messages: [], listeners: new Set(), queue: Promise.resolve(), channel: null };
      peers.set(id, peer);
      socket.send(JSON.stringify({ type: 'client-open', clientId: id }));
      await waitFor(peer, (message) => message.event === 'agentPool');
      return peer;
    };
    const show = async (peer, id) => {
      const data = await peer.channel.encryptJson({ id, method: 'setVisibleSessions', params: [['session']] });
      socket.send(JSON.stringify({ type: 'frame', clientId: peer.id, data }));
      await waitFor(peer, (message) => message.id === id);
    };
    await show(await open('new-phone', false), 1);
    await show(await open('old-phone', true), 2);
    assert.deepEqual(registrations, [
      { source: 'remote:new-phone', ids: ['session'], legacyTranscript: false },
      { source: 'remote:old-phone', ids: ['session'], legacyTranscript: true },
    ]);
  } finally {
    await handle?.close();
    socket?.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
