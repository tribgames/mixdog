import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ClientEvent, ConnectionStatus, StoreChange } from '../../../packages/protocol-client/src/index.ts';
import { createViewManager, type ViewClient } from './phone-view.ts';

const READY = { state: 'ready' } as unknown as ConnectionStatus;
const RECONNECTING = { state: 'reconnecting', attempt: 0 } as unknown as ConnectionStatus;
const REFUSED = { kind: 'rpc', code: -32000, message: 'refused' };

function rig(hold = false) {
  const calls: string[] = [];
  const held: Array<() => void> = [];
  const listeners = new Set<(event: ClientEvent) => void>();
  const subscribers = new Set<(change: StoreChange) => void>();
  const client = {
    status: READY,
    on: (listener: (event: ClientEvent) => void) => (listeners.add(listener), () => listeners.delete(listener)),
    store: { subscribe: (fn: (change: StoreChange) => void) => (subscribers.add(fn), () => subscribers.delete(fn)) },
    subscribeApp: async () => void calls.push('app'),
    resumeThread: async (id: string) => {
      calls.push(`resume:${id}`);
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
  const events = { synced: [] as boolean[], errors: 0, recycled: 0 };
  const manager = createViewManager(client, {
    restored: [],
    wanted: ['t1'],
    onSynced: (reconnected) => events.synced.push(reconnected),
    syncing: () => undefined,
    error: () => void (events.errors += 1),
    recycle: () => void (events.recycled += 1),
  });
  return { calls, client, status, store, events, manager, held };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settled = (promise: Promise<unknown>): Promise<'open' | 'shut'> => Promise.race([promise.then(() => 'open' as const), tick().then(() => 'shut' as const)]);

test('a reconnect whose re-attachment was refused keeps the gate shut and retries on the backoff', async () => {
  const { calls, status, store, events, manager } = rig();
  await manager.synced();
  assert.deepEqual(events.synced, [false]);
  status(RECONNECTING);
  status(READY);
  const gate = manager.synced();
  store({ type: 'subscription', feedId: 'app', state: 'restored' });
  store({ type: 'subscription', feedId: 't1', state: 'lost', error: REFUSED });
  assert.equal(await settled(gate), 'shut', 'one refused feed fails the whole re-attachment');
  assert.equal(events.errors, 1);
  assert.deepEqual(events.synced, [false], 'no connected report for a refused re-attachment');
  await gate;
  assert.deepEqual(calls.slice(-1), ['resume:t1'], 'the retry re-subscribes what the refusal dropped, not what was restored');
  assert.deepEqual(events.synced, [false, true]);
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
  const { store, events, manager, held } = rig(true);
  const gate = manager.synced();
  // Events of feeds restored (as a library would emit them) while the machine's own first sync is still attaching a thread.
  store({ type: 'subscription', feedId: 'app', state: 'restored' });
  store({ type: 'subscription', feedId: 't1', state: 'restored' });
  assert.equal(await settled(gate), 'shut');
  assert.deepEqual(events.synced, []);
  for (const release of held) release();
  await gate;
  assert.deepEqual(events.synced, [false]);
});
