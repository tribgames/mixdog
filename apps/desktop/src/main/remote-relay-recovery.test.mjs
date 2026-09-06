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

test('real encrypted clients recover independently and reads bypass a slow read without reordering writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-recovery-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  let handle, socket, publish, publishSessions, publishAgents, publishSessionState;
  const slow = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  const writes = [];
  let snapshot = { sessionId: 'session', items: [{ id: 1, text: 'retained text' }], status: 'idle' };
  const sessions = [{ id: 'session', title: 'Retained session', working: true }];
  const agents = [{ sessionId: 'worker', tag: 'worker', ownerSessionId: 'session', status: 'running' }];
  const catalogReads = { sessions: 0, agents: 0 };
  const host = {
    getSnapshot: () => snapshot,
    listSessions: async () => { catalogReads.sessions += 1; return sessions; },
    listAgentPool: async () => { catalogReads.agents += 1; return agents; },
    subscribe: (listener) => { publish = listener; return () => {}; },
    subscribeSessions: (listener) => { publishSessions = listener; return () => {}; },
    subscribeAgentPool: (listener) => { publishAgents = listener; return () => {}; },
    subscribeSessionStates: (listener) => { publishSessionState = listener; return () => {}; },
    setVisibleSessionsForSource: async (_source, ids) => {
      if (ids.includes('session')) {
        publishSessionState({ sessionId: 'session', snapshot, frameSource: 'replay' });
      }
      return true;
    },
    subscribeDesktopEvents: () => () => {},
    readProjectTextFile: async () => { readStarted.resolve(); return slow.promise; },
    addProject: async (path) => { writes.push(path); return path; },
    invokeDesktopOperation: async () => null,
  };
  const peers = new Map();
  const waitFor = (peer, match) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('No encrypted response within 5s.')), 5000);
    const check = () => {
      const message = peer.messages.find(match);
      if (message) finish(null, message);
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      peer.listeners.delete(check);
      if (error) reject(error); else resolve(value);
    };
    peer.listeners.add(check);
    check();
  });
  try {
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host,
    });
    [socket] = await connected;
    socket.on('message', (raw) => {
      const envelope = JSON.parse(String(raw));
      const peer = peers.get(envelope.clientId);
      if (envelope.type !== 'frame' || !peer) return;
      peer.queue = peer.queue.then(async () => {
        if (!peer.channel) {
          const handshake = await createRelayE2EEClientHandshake(handle.pairing, JSON.parse(envelope.data));
          peer.channel = handshake.channel;
          socket.send(JSON.stringify({ type: 'frame', clientId: peer.id, data: JSON.stringify(handshake.hello) }));
          return;
        }
        const message = await peer.channel.decryptJson(envelope.data);
        peer.messages.push(message);
        for (const listener of [...peer.listeners]) listener();
      }).catch((error) => { peer.error = error; });
    });
    const open = async (id) => {
      const peer = { id, messages: [], listeners: new Set(), queue: Promise.resolve(), channel: null };
      peers.set(id, peer);
      socket.send(JSON.stringify({ type: 'client-open', clientId: id }));
      await waitFor(peer, (message) => message.event === 'agentPool');
      return peer;
    };
    const send = async (peer, payload) => {
      const data = await peer.channel.encryptJson(payload);
      socket.send(JSON.stringify({ type: 'frame', clientId: peer.id, data }));
    };
    const a = await open('client-a');
    const b = await open('client-b');
    for (const peer of [a, b]) {
      assert.deepEqual((await waitFor(peer, (message) => message.event === 'sessions')).payload.rows.map((row) => row[1]), sessions);
      assert.deepEqual((await waitFor(peer, (message) => message.event === 'agentPool')).payload.rows.map((row) => row[1]), agents);
    }
    assert.deepEqual(catalogReads, { sessions: 1, agents: 1 }, 'join has real rows before any watcher changes');
    const states = (peer) => peer.messages.filter((message) => message.e === 'S' || message.event === 'state');
    await send(a, { id: 1, method: 'getSnapshot', params: [] });
    await waitFor(a, (message) => message.id === 1);
    assert.equal(states(a).length, 1, 'a second browser must not restart the first baseline');
    publishSessions(sessions);
    publishAgents(agents);
    await send(a, { id: 10, method: 'getSnapshot', params: [] });
    await waitFor(a, (message) => message.id === 10);
    for (const peer of [a, b]) {
      assert.equal(peer.messages.filter((message) => message.event === 'sessions').length, 1);
      assert.equal(peer.messages.filter((message) => message.event === 'agentPool').length, 1);
    }
    const beforeB = states(b).length;
    await send(a, { method: 'stateResync', params: [] });
    await send(a, { id: 2, method: 'getSnapshot', params: [] });
    await waitFor(a, (message) => message.id === 2);
    assert.equal(states(a).length, 2);
    assert.equal(states(b).length, beforeB);

    await send(a, { id: 3, method: 'readProjectFile', params: ['project', 'file.txt'] });
    await readStarted.promise;
    await send(a, { id: 4, method: 'getSnapshot', params: [] });
    assert.equal((await waitFor(a, (message) => message.id === 4)).ok, true);
    await send(a, { id: 5, method: 'addProject', params: ['next-project'] });
    await send(a, { id: 6, method: 'getSnapshot', params: [] });
    // Transport recovery still works while the application queue has a barrier.
    await send(a, { method: 'stateResync', params: [] });
    await waitFor(a, () => states(a).length === 3);
    assert.deepEqual(writes, []);
    assert.equal(a.messages.some((message) => message.id === 6), false);
    slow.resolve('file contents');
    await waitFor(a, (message) => message.id === 6);
    assert.deepEqual(writes, ['next-project']);
    assert.deepEqual(a.messages.filter((message) => [3, 5, 6].includes(message.id)).map((message) => message.id), [3, 5, 6]);

    snapshot = { ...snapshot, status: 'running' };
    publish(snapshot);
    await waitFor(b, () => states(b).length > beforeB);
    assert.equal(states(b).length, beforeB + 1);
    snapshot = {
      ...snapshot,
      items: [
        { id: 'user-prompt', kind: 'user', text: 'Keep this message on my phone' },
        ...Array.from({ length: 399 }, (_, id) => ({ id: `tool-${id}`, kind: 'tool', text: 'tool activity' })),
      ],
    };
    const decodeTranscript = (frame) => {
      const wire = frame.w ?? frame.payload.wire;
      if (frame.e === 'T' && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
      const decoded = createSnapshotDeltaDecoder().decode(wire);
      assert.equal(decoded.ok, true);
      return decoded.snapshot;
    };
    await send(a, { id: 20, method: 'setVisibleSessions', params: [['session']] });
    const firstTranscript = await waitFor(a, (message) => message.e === 'T' || message.event === 'sessionState');
    assert.deepEqual(decodeTranscript(firstTranscript).items, snapshot.items);
    socket.send(JSON.stringify({ type: 'client-close', clientId: a.id }));
    const reopened = await open(a.id);
    await send(reopened, { id: 21, method: 'setVisibleSessions', params: [['session']] });
    const restoredTranscript = await waitFor(reopened, (message) => message.e === 'T' || message.event === 'sessionState');
    assert.deepEqual(decodeTranscript(restoredTranscript).items, snapshot.items);
    assert.deepEqual(
      (await waitFor(reopened, (message) => message.event === 'agentPool')).payload.rows.map((row) => row[1]),
      agents,
    );
    assert.deepEqual(catalogReads, { sessions: 1, agents: 1 }, 'reconnect reuses the latest authoritative rosters');
    for (const peer of peers.values()) assert.equal(peer.error, undefined);
  } finally {
    slow.resolve('cleanup');
    await handle?.close();
    socket?.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
