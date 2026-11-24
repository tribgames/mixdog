// A wait for a thread's fold never leaves its listener behind, whichever way the wait ends.
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldTranscript, sharedFor } from './remote-protocol-chat.ts';

function fake(resume) {
  const store = new Set();
  const status = new Set();
  const origin = {};
  return {
    store: {
      subscribe: (listener) => (store.add(listener), () => store.delete(listener)),
      thread: () => ({ state: { origin, history: 'older', coreItems: [1], held: undefined } }),
    },
    on: (listener) => (status.add(listener), () => status.delete(listener)),
    resumeThread: resume,
    call: async () => ({}),
    pendingServerRequests: () => [],
    emitStore: (change) => [...store].forEach((listener) => listener(change)),
    emitStatus: (event) => [...status].forEach((listener) => listener(event)),
    listeners: () => store.size + status.size,
  };
}

test('whenFolded unsubscribes after a replay, an abort, a lost thread and a fold', async () => {
  const replay = fake();
  await sharedFor(replay).whenFolded('t', async () => ({ subscription: { mode: 'replay' } }));
  assert.equal(replay.listeners(), 0, 'a replay folds nothing');

  const slow = fake();
  const abort = new AbortController();
  const waiting = sharedFor(slow).whenFolded('t', () => new Promise(() => undefined), abort.signal);
  abort.abort();
  await waiting;
  assert.equal(slow.listeners(), 0, 'an abort ends the wait');

  const lost = fake();
  const lostWait = sharedFor(lost).whenFolded('t', async () => ({ subscription: { mode: 'snapshot' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  lost.emitStore({ type: 'subscription', feedId: 't', state: 'lost' });
  await lostWait;
  assert.equal(lost.listeners(), 0);

  const folded = fake();
  const foldedWait = sharedFor(folded).whenFolded('t', async () => ({ subscription: { mode: 'snapshot' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  folded.emitStore({ type: 'thread', threadId: 't' });
  await foldedWait;
  assert.equal(folded.listeners(), 0);
});

test('a page waits through a reconnect for its snapshot and ends, unsubscribed, when the client closes', async () => {
  const client = fake(async () => ({ subscription: { mode: 'snapshot' } }));
  const page = foldTranscript(client).page('t', { items: [] }, 10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.listeners(), 2);
  client.emitStatus({ type: 'status', status: { state: 'reconnecting' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.listeners(), 2, 'a reconnect is not the end of the wait: the snapshot may still land');
  client.emitStatus({ type: 'status', status: { state: 'closed' } });
  assert.equal(await page, false);
  assert.equal(client.listeners(), 0);
});

