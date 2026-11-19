import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ClientEvent, ConnectionStatus, StoreChange } from '../../../packages/protocol-client/src/index.ts';
import { createViewManager, type ViewClient } from './phone-view.ts';
import { createLaneFeeds, type LaneClient } from './phone-lanes.ts';

const READY = { state: 'ready' } as unknown as ConnectionStatus;
const RECONNECTING = { state: 'reconnecting', attempt: 0 } as unknown as ConnectionStatus;
const REFUSED = { kind: 'rpc', code: -32000, message: 'refused' };

function rig(hold = false, restored: string[] = []) {
  const calls: string[] = [];
  // What the core answers a wake's question with; each question is counted.
  const asked = { confirms: 0, answer: true };
  const held: Array<() => void> = [];
  // Settles when the machine's sync is attaching a thread: its own signal (the first sync starts a timer turn after the connection).
  let attaching = (): void => undefined;
  const resuming = new Promise<void>((resolve) => (attaching = resolve));
  const listeners = new Set<(event: ClientEvent) => void>();
  const subscribers = new Set<(change: StoreChange) => void>();
  const client = {
    status: READY,
    on: (listener: (event: ClientEvent) => void) => (listeners.add(listener), () => listeners.delete(listener)),
    store: { subscribe: (fn: (change: StoreChange) => void) => (subscribers.add(fn), () => subscribers.delete(fn)) },
    confirmFeeds: async () => (asked.confirms++, asked.answer),
    subscribeApp: async () => void calls.push('app'),
    resumeThread: async (id: string) => {
      calls.push(`resume:${id}`);
      attaching();
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
    },
    unsubscribeThread: async (id: string) => void calls.push(`drop:${id}`),
  } as unknown as ViewClient & { status: ConnectionStatus };
  const status = (next: ConnectionStatus) => {
    client.status = next;
    for (const listener of [...listeners]) listener({ type: 'status', status: next } as ClientEvent);
  };
  const store = (change: unknown) => {
    for (const fn of [...subscribers]) fn(change as StoreChange);
  };
  const events = { synced: 0, errors: 0, recycled: 0 };
  const manager = createViewManager(client, {
    restored,
    wanted: ['t1'],
    onSynced: () => void (events.synced += 1),
    syncing: () => undefined,
    error: () => void (events.errors += 1),
    recycle: () => void (events.recycled += 1),
    probe: () => undefined,
    silentSince: () => false,
  });
  return { calls, client, status, store, events, manager, held, resuming, asked };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settled = (promise: Promise<unknown>): Promise<'open' | 'shut'> => Promise.race([promise.then(() => 'open' as const), tick().then(() => 'shut' as const)]);

test('the terminal lane rejoins from dispatched output once, and redraws if that position is gone', async () => {
  const feedId = 'process:relay';
  const calls: unknown[] = [];
  let emit!: (event: ClientEvent) => void;
  let redraws = 0;
  const client = {
    status: READY,
    call: async (_method: string, params: unknown) => { calls.push(params); },
    on(listener: (event: ClientEvent) => void) { emit = listener; return () => undefined; },
  };
  const lanes = createLaneFeeds(client as unknown as LaneClient, { redraw: () => { redraws++; }, retire: assert.fail });
  const status = (next: ConnectionStatus) => {
    client.status = next;
    emit({ type: 'status', status: next });
  };
  const note = (method: string, epoch: string, seq: number) => emit({ type: 'notification', notification: { method, feed: { id: feedId, epoch, seq } } });
  lanes.declare('terminal', [feedId]);
  lanes.use(['terminal']);
  note('feed/snapshot', 'old', 0);
  note('process/outputDelta', 'old', 1);
  status(RECONNECTING);
  status(READY);
  lanes.use(['terminal']);
  assert.deepEqual(lanes.expected(), [feedId]);
  assert.deepEqual(calls, [{ feedId }, { feedId, resumeFrom: { epoch: 'old', seq: 1 } }]);
  assert.equal(redraws, 0);
  note('feed/snapshot', 'new', 0);
  assert.equal(redraws, 1);
  lanes.stop();
});

test('a reconnect whose re-attachment was refused keeps the gate shut and retries on the backoff', async () => {
  const { calls, status, store, events, manager } = rig();
  await manager.synced();
  assert.equal(events.synced, 1);
  status(RECONNECTING);
  status(READY);
  const gate = manager.synced();
  store({ type: 'subscription', feedId: 'app', state: 'restored' });
  store({ type: 'subscription', feedId: 't1', state: 'lost', error: REFUSED });
  assert.equal(await settled(gate), 'shut', 'one refused feed fails the whole re-attachment');
  assert.equal(events.errors, 1);
  assert.equal(events.synced, 1, 'no connected report for a refused re-attachment');
  await gate;
  assert.deepEqual(calls.slice(-1), ['resume:t1'], 'the retry re-subscribes what the refusal dropped, not what was restored');
  assert.equal(events.synced, 2);
});

test('a refused re-attachment three times in a row recycles the connection and rejects the waiting call', async () => {
  const { client, status, store, events, manager } = rig();
  await manager.synced();
  mock.timers.enable({ apis: ['setTimeout'] });
  client.resumeThread = async () => {
    throw REFUSED;
  };
  status(RECONNECTING);
  status(READY);
  const gate = manager.synced();
  const rejected = gate.then(
    () => 'resolved',
    (error: { code?: string }) => error.code
  );
  store({ type: 'subscription', feedId: 'app', state: 'restored' });
  store({ type: 'subscription', feedId: 't1', state: 'lost', error: REFUSED });
  // The refusal at the re-attachment, then 250 and 500 ms later: the third failure recycles.
  await tick();
  assert.equal(events.errors, 1, 'the refused re-attachment is the first failure');
  mock.timers.tick(250);
  await tick();
  assert.equal(events.errors, 2);
  assert.equal(events.recycled, 0);
  mock.timers.tick(500);
  await tick();
  assert.equal(events.recycled, 1);
  mock.timers.reset();
  status(RECONNECTING);
  assert.equal(await rejected, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED');
});

test('subscription events never open the gate: only the machine finishing a sync does', async () => {
  const { store, events, manager, held, resuming } = rig(true);
  const gate = manager.synced();
  // Events of feeds restored (as a library would emit them) while the machine's own first sync is still attaching a thread.
  store({ type: 'subscription', feedId: 'app', state: 'restored' });
  store({ type: 'subscription', feedId: 't1', state: 'restored' });
  await resuming;
  assert.equal(await settled(gate), 'shut');
  assert.equal(events.synced, 0);
  for (const release of held) release();
  await gate;
  assert.equal(events.synced, 1);
});

test('a first attach with K restored conversations sends the app feed and every thread together, and the list gate does not wait for a transcript', async () => {
  const { calls, manager, held, events, resuming } = rig(true, ['a', 'b', 'c', 'd']);
  const gate = manager.synced();
  const list = manager.appSynced();
  await resuming;
  assert.equal(await settled(list), 'open', 'the app feed is attached while every transcript is still being resumed');
  assert.deepEqual([...calls].sort(), ['app', 'resume:a', 'resume:b', 'resume:c', 'resume:d', 'resume:t1'], 'K + 1 requests, none waiting for another');
  assert.equal(await settled(gate), 'shut');
  assert.equal(held.length, 5);
  for (const release of held) release();
  await gate;
  assert.equal(events.synced, 1);
  assert.equal(calls.length, 6, 'nothing is asked twice');
});

test('a remembered thread deleted on the PC is dropped and the first sync still completes', async () => {
  const { client, calls, manager, events } = rig(false, ['gone', 'kept']);
  client.resumeThread = async (id: string) => {
    calls.push(`resume:${id}`);
    if (id === 'gone') throw { kind: 'rpc', code: -32000, message: 'no thread', reason: 'threadNotFound' };
  };
  await manager.synced();
  assert.equal(events.errors, 0, 'a deleted thread is not a failed sync');
  assert.equal(events.recycled, 0);
  assert.equal(events.synced, 1);
  await manager.set(['t1']);
  assert.equal(calls.filter((call) => call === 'resume:gone').length, 1, 'the deleted id is not asked for again');
});

test('a thread the page itself asked for still reports its refusal', async () => {
  const { client, manager, events } = rig();
  client.resumeThread = async () => {
    throw { kind: 'rpc', code: -32000, message: 'no thread', reason: 'threadNotFound' };
  };
  void manager.synced().catch(() => undefined);
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(events.errors >= 1, 'an explicit request is not silently dropped');
  } finally {
    manager.stop();
  }
});

test('a healthy wake costs one question to the core and no re-attach', async () => {
  const { calls, manager, asked, events } = rig();
  await manager.synced();
  const before = calls.length;
  assert.equal(await manager.wake(), true);
  assert.equal(asked.confirms, 1, 'the core is asked once');
  assert.equal(calls.length, before, 'no app subscription and no resume of a thread');
  assert.equal(events.synced, 1);
  asked.answer = false;
  assert.equal(await manager.wake(), false, 'the caller must run gap recovery when the core did not confirm');
});

test('a wake while a sync is still owed waits for it before asking', async (t) => {
  const { manager, asked, held, resuming } = rig(true);
  t.after(() => manager.stop());
  const gate = manager.synced();
  await resuming;
  const woke = manager.wake();
  try {
    assert.equal(await settled(woke), 'shut');
    assert.equal(asked.confirms, 0);
  } finally {
    for (const release of held) release();
    await Promise.all([gate, woke]);
  }
  assert.equal(await woke, true);
  assert.equal(asked.confirms, 1);
});
test('each sync carries its own claim: a reconnect between a sync\'s claim and its write cannot hand its frame to the next sync', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { client, status, manager } = rig();
  const claims: Array<(sent: Promise<void>) => void> = [];
  const called: Array<() => void> = [];
  const wrote = (n: number) => new Promise<void>((resolve) => (called[n] = resolve));
  const first = wrote(0);
  const second = wrote(1);
  let lose!: (error: unknown) => void;
  const lost = new Promise<void>((_, reject) => (lose = reject));
  lost.catch(() => undefined);
  client.subscribeApp = async (options?: { sent?: (sent: Promise<void>) => void }) => {
    claims.push(options!.sent!);
    called[claims.length - 1]?.();
    // The first sync's frame is still waiting to be written (the connection is being replaced) until its connection is lost.
    if (claims.length === 1) await lost;
  };
  // Its thread's resume is out on the same connection and ends with it.
  client.resumeThread = async () => (claims.length === 1 ? lost : undefined) as never;
  const gate = manager.synced();
  void gate.catch(() => undefined);
  mock.timers.tick(0);
  await first;
  status(RECONNECTING);
  lose({ kind: 'connectionLost' });
  status(READY);
  mock.timers.tick(0);
  await second;
  assert.equal(claims.length, 2);
  assert.notEqual(claims[0], claims[1], 'the second sync gets a claim of its own, not the first one\'s');
  mock.timers.reset();
});