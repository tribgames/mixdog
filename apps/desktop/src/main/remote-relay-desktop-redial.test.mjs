import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { startRemoteRelay } from './remote-relay.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';
import { createRelayE2EEClientHandshake } from '../shared/remote-e2ee.ts';
import { createKeyedListDeltaDecoder } from '../shared/list-delta.ts';
import { createRemoteViewBaselineCache } from '../shared/remote-view-baseline.ts';
import { markCompactPayload } from '../renderer/remote-compact-frames.ts';
import { createViewResumeRequest, readViewResumeGrant } from '../shared/remote-view-resume.ts';

const plain = (value) => JSON.parse(JSON.stringify(value));

// The relay keeps phone sockets across a desktop redial and replays their
// client-open on the new desktop leg (apps/relay/lib/relay-legs.mjs). The
// phone then resumes with the token it was issued and must receive only
// deltas — not the whole roster again.
test('a desktop relay redial keeps parked phone lanes: the replayed open resumes with deltas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-relay-redial-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const sockets = [];
  server.on('connection', (socket) => sockets.push(socket));
  const view = {
    snapshot: { sessionId: 'lead', status: 'idle', items: [], streamingTail: null, promptHistoryList: [] },
    sessions: Array.from({ length: 270 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      preview: `What happened in session ${index} `.repeat(6),
      cwd: `/work/project-${index % 9}`,
      working: false,
    })),
    agents: Array.from({ length: 40 }, (_, index) => ({
      sessionId: `agent-${index}`,
      tag: `agent-${index}`,
      ownerSessionId: 'session-0',
      status: 'idle',
    })),
  };
  const host = {
    getSnapshot: () => view.snapshot,
    listSessions: async () => view.sessions,
    listAgentPool: async () => view.agents,
    subscribe: () => () => {},
    subscribeSessions: () => () => {},
    subscribeAgentPool: () => () => {},
    subscribeSessionStates: () => () => {},
    subscribeDesktopEvents: () => () => {},
    setVisibleSessionsForSource: async () => true,
    replaySessionStates: async (_ids, deliver) => deliver([]),
    invokeDesktopOperation: async () => null,
  };
  // One phone, as remote-shim decodes; its socket outlives the desktop leg.
  const cache = createRemoteViewBaselineCache();
  const decoders = {
    state: createSnapshotDeltaDecoder(),
    sessions: createKeyedListDeltaDecoder(),
    agentPool: createKeyedListDeltaDecoder(),
  };
  const shown = { state: null, sessions: null, agents: null };
  const phone = { id: 'phone-1', channel: null, messages: [], bytes: 0, waiters: new Set() };
  const apply = (frame) => {
    if (frame.event === 'viewBaseline') return apply(cache.restore(frame.payload));
    const decode = (decoder, payload) => {
      const result = decoder.decode(payload);
      assert.equal(result.ok, true, `a ${frame.event} frame applies to what the phone holds`);
      return result;
    };
    if (frame.e === 'S') {
      markCompactPayload(frame.w);
      shown.state = decode(decoders.state, frame.w).snapshot;
    } else if (frame.event === 'state') shown.state = decode(decoders.state, frame.payload).snapshot;
    else if (frame.event === 'sessions') shown.sessions = decode(decoders.sessions, frame.payload).items;
    else if (frame.event === 'agentPool') shown.agents = decode(decoders.agentPool, frame.payload).items;
  };
  const waitFor = (match) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        phone.waiters.delete(check);
        reject(new Error('No encrypted message within 5s.'));
      }, 5_000);
      const check = () => {
        const message = phone.messages.find(match);
        if (!message) return;
        clearTimeout(timer);
        phone.waiters.delete(check);
        resolve(message);
      };
      phone.waiters.add(check);
      check();
    });
  let handle;
  /** The relay announcing the phone on desktop leg `socket`: a fresh handshake. */
  const open = async (socket) => {
    phone.channel = null;
    phone.messages = [];
    let queue = Promise.resolve();
    socket.on('message', (raw) => {
      const envelope = JSON.parse(String(raw));
      if (envelope.type !== 'frame' || envelope.clientId !== phone.id) return;
      queue = queue.then(async () => {
        if (!phone.channel) {
          const handshake = await createRelayE2EEClientHandshake(handle.pairing, JSON.parse(envelope.data));
          phone.channel = handshake.channel;
          const hello = { ...handshake.hello, viewSync: 1, listDelta: 1 };
          socket.send(JSON.stringify({ type: 'frame', clientId: phone.id, data: JSON.stringify(hello) }));
          return;
        }
        const message = await phone.channel.decryptJson(envelope.data);
        // Decoded size: the encrypted envelope compresses its payload.
        phone.bytes += JSON.stringify(message).length;
        if (message.event || message.e) apply(message);
        phone.messages.push(message);
        for (const check of [...phone.waiters]) check();
      });
    });
    socket.send(JSON.stringify({ type: 'client-open', clientId: phone.id }));
    await waitFor((message) => message.type === 'e2ee-ready');
  };
  let callId = 0;
  const synchronize = async (socket, token) => {
    const offer = cache.begin();
    const id = ++callId;
    const before = phone.bytes;
    const resume = await createViewResumeRequest(
      token,
      token
        ? {
            state: decoders.state.claim(),
            sessions: decoders.sessions.claim(),
            agentPool: decoders.agentPool.claim(),
            sessionStates: [],
          }
        : null
    );
    const data = await phone.channel.encryptJson({ id, method: 'synchronizeViews', params: [[], offer.offer, resume] });
    socket.send(JSON.stringify({ type: 'frame', clientId: phone.id, data }));
    try {
      const answer = await waitFor((message) => message.id === id);
      assert.equal(answer.ok, true, answer.error);
      const frames = phone.messages.filter((message) => message.event || message.e);
      return { token: readViewResumeGrant(answer.value), frames, bytes: phone.bytes - before };
    } finally {
      offer.finish();
    }
  };
  const assertShown = () => {
    assert.deepEqual(plain(shown.state), plain(view.snapshot));
    assert.deepEqual(shown.sessions, plain(view.sessions));
    assert.deepEqual(shown.agents, plain(view.agents));
  };
  try {
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${server.address().port}`, userDataPath: dir, host });
    while (sockets.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await open(sockets[0]);
    const joined = await synchronize(sockets[0], null);
    assert.ok(joined.token, 'a resume-capable phone is issued a token');
    assertShown();

    // The desktop's own leg drops (a network blip); the phone socket stays.
    sockets[0].terminate();
    while (sockets.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    view.sessions = [{ ...view.sessions[0], working: true }, ...view.sessions.slice(1)];
    view.snapshot = { ...view.snapshot, status: 'running' };
    await open(sockets[1]);
    const resumed = await synchronize(sockets[1], joined.token);
    assertShown();
    assert.equal(
      resumed.frames.filter((frame) => frame.event === 'viewBaseline').length,
      0,
      'no lane falls back to a full baseline'
    );
    t.diagnostic(`desktop redial: resumed ${resumed.bytes} B vs full open ${joined.bytes} B`);
    assert.ok(resumed.bytes * 20 < joined.bytes, `resumed ${resumed.bytes} bytes vs ${joined.bytes} full`);
  } finally {
    await handle?.close();
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
