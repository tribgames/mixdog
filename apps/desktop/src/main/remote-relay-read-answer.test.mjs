// A phone opens a chat by reading it BEFORE its visible-session registration
// names it (the desktop transport forwards that answer: shouldPublishSessionState).
// The relay fan-out dropped it, so the opened chat sat on its loading skeleton
// until a later visibility sync re-sent the baseline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';
import { createRelaySessionStateFanout } from './remote-relay-session-state.ts';

const SESSION = `sess_desktop_${'b'.repeat(64)}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function relayClient() {
  return {
    channel: {},
    syncing: false,
    visibleSessionIds: new Set(),
    requestedReads: new Set(),
    sessionStateEncoders: new Map(),
    sessionHandles: new Map(),
    compactWire: false,
    transcriptPrepend: false,
    promptHistoryPatch: false,
    firstTranscriptReported: true,
    openedAt: Date.now(),
  };
}

function frame(text, frameSource = 'replay') {
  return {
    sessionId: SESSION,
    frameSource,
    snapshot: { sessionId: SESSION, busy: false, items: [{ id: `it_${text}`, kind: 'user', text }] },
  };
}

test("a read's answer reaches the phone that asked before the session is visible", async () => {
  const client = relayClient();
  const sent = [];
  const fanout = createRelaySessionStateFanout({
    clients: new Map([['phone', client]]),
    sendEncryptedFrame: async (clientId, payload) => {
      sent.push([clientId, payload]);
    },
  });
  const methods = createRemoteMethods(
    {
      host: {
        // The host publishes the replay while the read is in flight.
        prefetchSession: async (sessionId) => {
          fanout.publish(frame('history'));
          return sessionId === SESSION;
        },
      },
    },
    {
      requestRead: (sessionId) => client.requestedReads.add(sessionId),
      releaseRead: (sessionId) => client.requestedReads.delete(sessionId),
    }
  );
  assert.equal(await methods.prefetchSession([SESSION, 40]), true);
  await settle();
  assert.equal(sent.length, 1, 'the replay answering the read is delivered');
  assert.equal(sent[0][1].payload.sessionId, SESSION);
  assert.deepEqual(
    sent[0][1].payload.wire.items.map((item) => item.text),
    ['history']
  );
  // The answer is consumed: live frames of a session the phone does not show stay home.
  fanout.publish(frame('later', 'live'));
  await settle();
  assert.equal(sent.length, 1);
});

test('a live frame racing the read keeps the mark: the replay answering it still arrives, nothing droppable', async () => {
  const client = relayClient();
  client.requestedReads.add(SESSION);
  const sent = [];
  const fanout = createRelaySessionStateFanout({
    clients: new Map([['phone', client]]),
    sendEncryptedFrame: async (_clientId, payload, droppable) => {
      sent.push({ payload, droppable });
    },
  });
  fanout.publish(frame('streaming', 'live'));
  await settle();
  assert.equal(client.requestedReads.has(SESSION), true, 'a live frame is not the answer');
  fanout.publish(frame('history'));
  await settle();
  assert.equal(sent.length, 2, 'the replay is delivered after the live frame');
  assert.deepEqual(
    sent.map((entry) => entry.droppable),
    [false, false],
    'frames to a waiting asker are never dropped'
  );
  assert.equal(client.requestedReads.has(SESSION), false, 'the replay consumed the mark');
});

test('a failed read stops awaiting its answer', async () => {
  const client = relayClient();
  const methods = createRemoteMethods(
    { host: { prefetchSession: async () => false } },
    {
      requestRead: (sessionId) => client.requestedReads.add(sessionId),
      releaseRead: (sessionId) => client.requestedReads.delete(sessionId),
    }
  );
  assert.equal(await methods.prefetchSession([SESSION, 40]), false);
  assert.equal(client.requestedReads.has(SESSION), false);
});

test('a visible session keeps receiving live frames', async () => {
  const client = relayClient();
  client.visibleSessionIds.add(SESSION);
  const sent = [];
  const fanout = createRelaySessionStateFanout({
    clients: new Map([['phone', client]]),
    sendEncryptedFrame: async (_clientId, payload) => {
      sent.push(payload);
    },
  });
  fanout.publish(frame('one', 'live'));
  await settle();
  fanout.publish(frame('two', 'live'));
  await settle();
  assert.equal(sent.length, 2);
});
