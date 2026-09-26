import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startRemoteRelay } from './remote-relay.ts';
import { createRelayE2EEClientHandshake } from '../shared/remote-e2ee.ts';
import { createSnapshotDeltaDecoder, markCompactWire } from './state-delta.ts';

test('a paging phone opens tail windows and receives older pages as prepends; an older build keeps the legacy page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-paging-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const registrations = [];
  let publishSessionState = () => {};
  const host = {
    getSnapshot: () => null,
    listSessions: async () => [],
    listAgentPool: async () => [],
    subscribe: () => () => {},
    subscribeSessions: () => () => {},
    subscribeAgentPool: () => () => {},
    subscribeSessionStates: (listener) => {
      publishSessionState = listener;
      return () => {};
    },
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
          assert.equal(challenge.transcriptPrepend, 1, 'the desktop offers prepend pages');
          const handshake = await createRelayE2EEClientHandshake(handle.pairing, challenge);
          const hello = { ...handshake.hello };
          // An older phone build never echoes a flag it does not know.
          if (peer.legacy) {
            delete hello.transcriptPaging;
            delete hello.transcriptPrepend;
          } else {
            assert.equal(hello.transcriptPaging, 1);
            assert.equal(hello.transcriptPrepend, 1);
          }
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
    const newPhone = await open('new-phone', false);
    await show(newPhone, 1);
    const oldPhone = await open('old-phone', true);
    await show(oldPhone, 2);
    assert.deepEqual(registrations, [
      { source: 'remote:new-phone', ids: ['session'], legacyTranscript: false },
      { source: 'remote:old-phone', ids: ['session'], legacyTranscript: true },
    ]);

    // An older page arrives above the rows both phones already hold.
    const row = (id) => ({ id, kind: 'assistant', text: `row ${id}` });
    const held = ['r0', 'r1', 'r2'].map(row);
    const paged = [row('h0'), row('h1'), ...held];
    const frames = (peer) => peer.messages.filter((message) => message.e === 'T');
    const decoders = new Map([
      [newPhone, createSnapshotDeltaDecoder()],
      [oldPhone, createSnapshotDeltaDecoder()],
    ]);
    const decode = (peer, frame) => {
      const wire = frame.w;
      if (!Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
      const decoded = decoders.get(peer).decode(wire);
      assert.equal(decoded.ok, true);
      return decoded.snapshot.items.map((item) => item.id);
    };
    publishSessionState({ sessionId: 'session', snapshot: { sessionId: 'session', items: held }, frameSource: 'live' });
    for (const peer of [newPhone, oldPhone]) {
      await waitFor(peer, (message) => message.e === 'T');
      assert.deepEqual(decode(peer, frames(peer)[0]), ['r0', 'r1', 'r2']);
    }
    publishSessionState({ sessionId: 'session', snapshot: { sessionId: 'session', items: paged }, frameSource: 'replay' });
    for (const peer of [newPhone, oldPhone]) await waitFor(peer, () => frames(peer).length === 2);
    const page = frames(newPhone)[1].w.ip;
    assert.deepEqual(
      page.h.map((item) => item.id),
      ['h0', 'h1'],
      'a paging phone receives only the revealed rows'
    );
    assert.equal(page.p, 3);
    assert.deepEqual(page.a, []);
    const legacyPage = frames(oldPhone)[1].w.ip;
    assert.equal(Object.hasOwn(legacyPage, 'h'), false, 'an older build is never sent a prepend');
    assert.equal(legacyPage.p, 0);
    assert.equal(legacyPage.a.length, 5);
    for (const peer of [newPhone, oldPhone]) {
      assert.deepEqual(decode(peer, frames(peer)[1]), ['h0', 'h1', 'r0', 'r1', 'r2']);
    }
  } finally {
    await handle?.close();
    socket?.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
