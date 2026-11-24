// What the client keeps per feed (fold chains, last-event marks, the window a snapshot will fold) ends with the feed or the client.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const tick = () => new Promise<void>((r) => setImmediate(r));
const thread = {
  id: 'lead',
  preview: '',
  title: '',
  updatedAt: 1,
  messageCount: 0,
  cwd: '/w',
  classification: {},
  projectPath: null,
};
type Held = {
  feedChains: Map<string, unknown>;
  threadLastEvent: Map<string, number>;
  tokenWindow: Map<number, unknown>;
};

async function rig() {
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const held = client as unknown as Held;
  const resume = async (id = 'lead') => {
    const resumed = client.resumeThread(id, { lastItems: 50 });
    const req = JSON.parse(await conn.nextSent());
    conn.serverSend({
      id: req.id,
      result: { thread: { ...thread, id }, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
    });
    await resumed;
  };
  const snapshot = async () => {
    conn.serverSend({
      method: 'thread/snapshot',
      params: { thread, items: [], state: {}, hasOlder: false },
      feed: { id: 'lead', epoch: 'e1', seq: 0 },
    });
    for (let i = 0; i < 5; i++) await tick();
  };
  const unsubscribe = async () => {
    const gone = client.unsubscribeThread('lead');
    conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result: {} });
    await gone;
  };
  return { client, held, conn, resume, snapshot, unsubscribe };
}

test('an unsubscribe before the snapshot leaves no window waiting, and a snapshot consumes the one it was asked with', async () => {
  const { held, resume, snapshot, unsubscribe, client } = await rig();
  await resume();
  assert.equal(held.tokenWindow.size, 1, 'waiting for the snapshot');
  await unsubscribe();
  assert.equal(held.tokenWindow.size, 0, 'the snapshot that would have consumed it can no longer come');
  await resume();
  await snapshot();
  assert.equal(held.tokenWindow.size, 0);
  await client.close();
});

test('a feed that ends leaves no fold chain and no last-event mark', async () => {
  const { held, resume, snapshot, unsubscribe, client } = await rig();
  await resume();
  await snapshot();
  assert.ok(held.feedChains.has('lead'));
  assert.ok(held.threadLastEvent.has('lead'));
  await unsubscribe();
  assert.equal(held.feedChains.has('lead'), false);
  assert.equal(held.threadLastEvent.has('lead'), false);
  await client.close();
});

test('a close with an attach still waiting for its snapshot leaves all three maps empty', async () => {
  const { held, resume, snapshot, client } = await rig();
  await resume();
  await snapshot();
  await resume('other');
  assert.equal(held.tokenWindow.size, 1, 'the second attach waits for its snapshot');
  await client.close();
  assert.equal(held.feedChains.size, 0);
  assert.equal(held.threadLastEvent.size, 0);
  assert.equal(held.tokenWindow.size, 0);
});

test('a mutation refused for a full window retries at the next event of its thread, though the thread was unsubscribed meanwhile', async () => {
  const { conn, resume, snapshot, unsubscribe, client, held } = await rig();
  await resume();
  await snapshot();
  const call = client.call('turn/start', { threadId: 'lead' } as never);
  const first = JSON.parse(await conn.nextSent());
  conn.serverSend({
    id: first.id,
    error: { code: -32001, message: 'full', data: { reason: 'windowFull', threadId: 'lead' } },
  });
  await tick();
  await unsubscribe();
  // An event of the thread already on its way when it was let go is what the refused request waits for.
  conn.serverSend({ method: 'thread/runtime/updated', params: {}, feed: { id: 'lead', epoch: 'e1', seq: 5 } });
  const retried = await Promise.race([
    conn.nextSent().then((text) => JSON.parse(text)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
  ]);
  assert.equal(retried?.method, 'turn/start', 'retried at once, not after a request timeout');
  conn.serverSend({ id: retried.id, result: {} });
  await call;
  assert.equal(held.threadLastEvent.has('lead'), false, 'the mark goes when the last request for the thread settles');
  await client.close();
});

test('an event of a thread no request waits on, arriving after its unsubscribe, leaves no mark', async () => {
  const { conn, held, resume, snapshot, unsubscribe, client } = await rig();
  await resume();
  await snapshot();
  await unsubscribe();
  conn.serverSend({ method: 'thread/runtime/updated', params: {}, feed: { id: 'lead', epoch: 'e1', seq: 5 } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(held.threadLastEvent.has('lead'), false);
  await client.close();
});

test('a closed client holds no fold chain, last-event mark or window', async () => {
  const { held, resume, snapshot, client } = await rig();
  await resume();
  await snapshot();
  await client.close();
  assert.equal(held.feedChains.size, 0);
  assert.equal(held.threadLastEvent.size, 0);
  assert.equal(held.tokenWindow.size, 0);
});




test('a call that gives up while the link is down leaves no request, mark or ready waiter behind', async () => {
  const { conn, client, held } = await rig();
  conn.serverClose(1006);
  for (let i = 0; i < 5; i++) await tick();
  const pending = client.call('turn/start', { threadId: 'lead' } as never, { timeoutMs: 30 });
  await assert.rejects(pending);
  const inner = client as unknown as { requestsFor: Map<string, number>; readyWaiters: unknown[]; wake: unknown[] };
  assert.equal(inner.requestsFor.size, 0);
  assert.equal(inner.readyWaiters.length, 0);
  assert.equal(held.threadLastEvent.has('lead'), false);
  await client.close();
});

test('a call that gives up while waiting for a full window stops waiting for events', async () => {
  const { conn, resume, snapshot, client } = await rig();
  await resume();
  await snapshot();
  const call = client.call('turn/start', { threadId: 'lead' } as never, { timeoutMs: 40 });
  const first = JSON.parse(await conn.nextSent());
  conn.serverSend({
    id: first.id,
    error: { code: -32001, message: 'full', data: { reason: 'windowFull', threadId: 'lead' } },
  });
  await assert.rejects(call);
  for (let i = 0; i < 3; i++) await tick();
  const inner = client as unknown as { requestsFor: Map<string, number>; wake: unknown[] };
  assert.equal(inner.requestsFor.size, 0);
  assert.equal(inner.wake.length, 0, 'no waiter is left to be woken by the next event');
  await client.close();
});

test('a whenHeldSettled that gives up while the link is down leaves no ready waiter behind', async () => {
  const { conn, client } = await rig();
  conn.serverClose(1006);
  for (let i = 0; i < 5; i++) await tick();
  const held = client as unknown as { whenHeldSettled(id: string, options?: { timeoutMs?: number }): Promise<void> };
  await assert.rejects(held.whenHeldSettled('lead', { timeoutMs: 30 }));
  assert.equal((client as unknown as { readyWaiters: unknown[] }).readyWaiters.length, 0);
  await client.close();
});
