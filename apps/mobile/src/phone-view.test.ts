import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { ClientEvent, ConnectionStatus, StoreChange } from '../../../packages/protocol-client/src/index.ts';
import { createViewManager, STRAY_FOLLOW_RELEASE_MS, type ViewClient } from './phone-view.ts';
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
    on: (listener: (event: ClientEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    store: {
      subscribe: (fn: (change: StoreChange) => void) => {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    },
    confirmFeeds: async () => {
      asked.confirms++;
      return asked.answer;
    },
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
    onSynced: () => {
      events.synced += 1;
    },
    syncing: () => undefined,
    error: () => {
      events.errors += 1;
    },
    recycle: () => {
      events.recycled += 1;
    },
    probe: () => undefined,
    silentSince: () => false,
  });
  return { calls, client, status, store, events, manager, held, resuming, asked };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settled = (promise: Promise<unknown>): Promise<'open' | 'shut'> =>
  Promise.race([promise.then(() => 'open' as const), tick().then(() => 'shut' as const)]);

test('the terminal lane rejoins from dispatched output once, and redraws if that position is gone', async () => {
  const feedId = 'process:relay';
  const calls: unknown[] = [];
  let emit!: (event: ClientEvent) => void;
  let redraws = 0;
  const client = {
    status: READY,
    call: async (_method: string, params: unknown) => {
      calls.push(params);
    },
    on(listener: (event: ClientEvent) => void) {
      emit = listener;
      return () => undefined;
    },
  };
  const lanes = createLaneFeeds(client as unknown as LaneClient, {
    redraw: () => {
      redraws++;
    },
    retire: assert.fail,
  });
  const status = (next: ConnectionStatus) => {
    client.status = next;
    emit({ type: 'status', status: next });
  };
  const note = (method: string, epoch: string, seq: number) =>
    emit({ type: 'notification', notification: { method, feed: { id: feedId, epoch, seq } } });
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
  assert.deepEqual(
    calls.slice(-1),
    ['resume:t1'],
    'the retry re-subscribes what the refusal dropped, not what was restored'
  );
  assert.equal(events.synced, 2);
});

test('a thread followed outside the view is let go once it stayed unwanted, and one a pane names or the client holds is kept', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, client, manager } = rig();
  t.after(() => {
    manager.stop();
    mock.timers.reset();
  });
  mock.timers.tick(0);
  await manager.synced();
  // What the client follows: the pane's thread, two the list prefetched, and the control thread it holds.
  following(client, new Set(['t1', 'hovered', 'opened', 'control']), new Set(), new Set(['control']));
  const drops = () => calls.filter((call) => call.startsWith('drop:'));
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.deepEqual(drops(), [], 'a thread just prefetched is not let go');
  await manager.set(['t1', 'opened']);
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.deepEqual(drops(), ['drop:hovered']);
});

/** The rig's client, following `folds` outside the view; `restoring` names the threads whose resume after a reconnect is out, `held` the control threads. */
function following(client: ViewClient, folds: Set<string>, restoring = new Set<string>(), held = new Set<string>()) {
  const library = client as unknown as {
    store: { threads: { keys(): Iterable<string> } };
    threadSubscription(id: string): { followed: boolean; held: boolean; restoring: boolean };
  };
  library.store.threads = { keys: () => folds.keys() };
  library.threadSubscription = (id) => ({
    followed: folds.has(id),
    held: held.has(id),
    restoring: restoring.has(id),
  });
}

test('a stray whose restore after a reconnect is still out is not let go until that restore has ended', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, client, manager } = rig();
  t.after(() => {
    manager.stop();
    mock.timers.reset();
  });
  mock.timers.tick(0);
  await manager.synced();
  const restoring = new Set<string>();
  following(client, new Set(['t1', 'hovered']), restoring);
  const drops = () => calls.filter((call) => call.startsWith('drop:'));
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  // The phone reconnected: the library's resume of the thread is in flight when the release sweep runs.
  restoring.add('hovered');
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.deepEqual(drops(), [], 'an unsubscribe now could be answered before the restore attaches the thread');
  restoring.clear();
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.deepEqual(drops(), ['drop:hovered']);
});

test("a stray's age is its follow's: a thread a pane showed in between starts over when it is followed outside the view again", async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, client, manager } = rig();
  t.after(() => {
    manager.stop();
    mock.timers.reset();
  });
  mock.timers.tick(0);
  await manager.synced();
  const folds = new Set(['t1', 'T']);
  following(client, folds);
  const drops = () => calls.filter((call) => call === 'drop:T').length;
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.equal(drops(), 0);
  // A pane opens the thread and closes it (the view lets it go itself); the list prefetches it again just before the sweep.
  await manager.set(['t1', 'T']);
  await manager.set(['t1']);
  assert.equal(drops(), 1, 'the view released the thread its pane closed');
  folds.add('T');
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.equal(drops(), 1, 'the new follow is not let go on the age of the one before it');
  mock.timers.tick(STRAY_FOLLOW_RELEASE_MS / 2);
  assert.equal(drops(), 2);
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

test('a re-attachment the core never answers is still owed by every retry, so the third failed sync recycles', async () => {
  const { status, events, manager } = rig();
  await manager.synced();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    status(RECONNECTING);
    status(READY);
    const gate = manager.synced();
    void gate.catch(() => undefined);
    // No restore event ever arrives: each sync's watch fails it (20 s, then the probe's 5 s), and the backoff retries.
    for (const [failures, backoff] of [
      [1, 250],
      [2, 500],
      [3, 0],
    ] as const) {
      mock.timers.tick(20_000);
      await tick();
      mock.timers.tick(5_000);
      await tick();
      assert.equal(events.errors, failures);
      assert.equal(events.synced, 1, 'no connected report while the restores are unanswered');
      mock.timers.tick(backoff);
      await tick();
    }
    assert.equal(events.recycled, 1);
  } finally {
    mock.timers.reset();
    manager.stop();
  }
});

test('a wake check the core never answers fails as its watch does', async () => {
  const { client, manager } = rig();
  await manager.synced();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    (client as unknown as { confirmFeeds: () => Promise<boolean> }).confirmFeeds = () =>
      new Promise<boolean>(() => undefined);
    const woke = manager.wake();
    const outcome = woke.then(
      () => 'answered',
      (error: Error) => error.message
    );
    await tick();
    mock.timers.tick(20_000);
    await tick();
    mock.timers.tick(5_000);
    assert.equal(await outcome, 'mixdog remote call timed out.');
  } finally {
    mock.timers.reset();
    manager.stop();
  }
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
  assert.deepEqual(
    [...calls].sort(),
    ['app', 'resume:a', 'resume:b', 'resume:c', 'resume:d', 'resume:t1'],
    'K + 1 requests, none waiting for another'
  );
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
    const resumed: Awaited<ReturnType<ViewClient['resumeThread']>> = {
      thread: { id, preview: '', title: '', updatedAt: 0, messageCount: 0, cwd: '', classification: null },
      subscription: { id: `sub-${id}`, mode: 'replay', epoch: 'e1', startSeq: 0, liveSeq: 0 },
    };
    return resumed;
  };
  await manager.synced();
  assert.equal(events.errors, 0, 'a deleted thread is not a failed sync');
  assert.equal(events.recycled, 0);
  assert.equal(events.synced, 1);
  await manager.set(['t1']);
  assert.equal(calls.filter((call) => call === 'resume:gone').length, 1, 'the deleted id is not asked for again');
});

const THREAD_GONE = { kind: 'rpc', code: -32000, message: 'no thread', reason: 'threadNotFound', data: undefined };

test('a thread the page names that the PC does not have is no failed sync, and is asked for again only when named anew', async (t) => {
  const { client, calls, manager, events } = rig();
  t.after(() => manager.stop());
  client.resumeThread = async (id: string) => {
    calls.push(`resume:${id}`);
    throw THREAD_GONE;
  };
  await manager.synced();
  assert.equal(events.errors, 0);
  assert.equal(events.recycled, 0);
  const asked = () => calls.filter((call) => call === 'resume:t1').length;
  await manager.set(['t1']);
  assert.equal(asked(), 1, 'still named, it is not asked for again');
  await manager.set([]);
  await manager.set(['t1']);
  assert.equal(asked(), 2, 'named anew, it is asked for again');
});

test('a shown thread deleted on the PC while the phone was away ends with the reconnect: the sync completes, the connection is kept', async (t) => {
  const { client, calls, status, store, manager, events } = rig();
  t.after(() => manager.stop());
  await manager.synced();
  client.resumeThread = async (id: string) => {
    calls.push(`resume:${id}`);
    throw THREAD_GONE;
  };
  status(RECONNECTING);
  status(READY);
  // The library's restores on the new connection: the app feed comes back, the deleted thread's resume is refused.
  store({ type: 'subscription', feedId: 'app', state: 'restored' });
  store({ type: 'subscription', feedId: 't1', state: 'lost', error: THREAD_GONE });
  assert.equal(await settled(manager.synced()), 'open', 'the calls gated on the view go on');
  assert.equal(events.errors, 0);
  assert.equal(events.recycled, 0);
  await manager.set(['t1']);
  assert.equal(calls.filter((call) => call === 'resume:t1').length, 1, 'only the first connection asked for it');
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
test("each sync carries its own claim: a reconnect between a sync's claim and its write cannot hand its frame to the next sync", async () => {
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
  assert.notEqual(claims[0], claims[1], "the second sync gets a claim of its own, not the first one's");
  mock.timers.reset();
});
