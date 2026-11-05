// A thread snapshot folds in bounded turns and swaps in whole; the feed waits behind it; a disconnect discards it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { StoreChange } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
import { FakeTurn, UNITS_PER_TURN } from './fake-turn.ts';
import type { SessionFold } from '../src/session-state.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const tick = () => new Promise<void>((r) => setImmediate(r));
const thread = { id: 'lead', preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null };

/** The session reducer, each step of its stepped fold counted as a unit of work in the turn it runs in. */
function countedReducer(turn: FakeTurn, hooks: { atCompletion?: () => void }): typeof sessionReducer {
  return {
    ...sessionReducer,
    *initialSteps(snapshot) {
      const steps = sessionReducer.initialSteps!(snapshot);
      for (;;) {
        turn.work();
        const r = steps.next();
        if (r.done) {
          hooks.atCompletion?.();
          return r.value;
        }
        yield;
      }
    },
  };
}

async function setup(turn: FakeTurn, hooks: { atCompletion?: () => void } = {}) {
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: countedReducer(turn, hooks),
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
    turn: turn.options,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const resumed = client.resumeThread('lead', { lastItems: 50 });
  const req = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: req.id, result: { thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 1 } } });
  await resumed;
  const changes: StoreChange[] = [];
  client.store.subscribe((c) => changes.push(c));
  return { conn, client, changes };
}
const notification = (method: string, params: unknown, seq: number) => ({ method, params, feed: { id: 'lead', epoch: 'e1', seq } });
const snapshotParams = (items: unknown[]) => ({ thread, items, state: { title: 'T' }, hasOlder: false });
/** ~1.1 MB: user prompts, replies and tool calls with bodies of a few hundred bytes. */
function bigItems(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => {
    const meta = { at: i, status: 'completed' };
    if (i % 3 === 0) return { type: 'userMessage', id: `u${i}`, content: [{ type: 'text', text: 'q'.repeat(380) }], meta };
    if (i % 3 === 1) return { type: 'agentMessage', id: `a${i}`, text: 'a'.repeat(480), meta };
    return { type: 'toolCall', id: `t${i}`, name: 'read', input: { path: `src/f${i}.ts` }, output: 'o'.repeat(380), meta };
  });
}
const items = (client: { store: { thread(id: string): { state: SessionFold } | undefined } }) => client.store.thread('lead')?.state.items.length;

test('a 1 MB thread snapshot folds in bounded turns, swaps in whole, and the feed waits behind it', async () => {
  const turn = new FakeTurn();
  const { conn, client, changes } = await setup(turn);
  conn.serverSend(notification('thread/snapshot', snapshotParams(bigItems(3)), 0));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(items(client), 3);
  changes.length = 0;

  const N = 2000;
  const frame = JSON.stringify(notification('thread/snapshot', snapshotParams(bigItems(N)), 1));
  assert.ok(frame.length > 1_000_000, `frame ${frame.length}`);
  const delta = notification('thread/name/updated', { threadId: 'lead', title: 'after' }, 2);

  turn.reset();
  let folding = true;
  const seen: Array<[number | undefined, unknown]> = [];
  client.store.subscribe((c) => {
    if (c.type !== 'thread') return;
    const fold = client.store.thread('lead')!.state;
    seen.push([fold.items.length, fold.fields.desktopSessionTitle]);
    if (seen.length === 2) folding = false;
  });
  // The previous fold is whole and readable until the swap: sample it on every turn.
  const samples = new Set<number | undefined>();
  const sampler = (async () => {
    while (folding) {
      samples.add(items(client));
      await tick();
    }
  })();
  conn.serverSendRaw(frame);
  conn.serverSend(delta); // arrives while the snapshot is still folding
  while (folding) await tick();
  await sampler;

  assert.deepEqual([...samples], [3], 'the store showed only the previous state until the swap');
  assert.deepEqual(seen, [[N, 'T'], [N, 'after']], 'one change for the snapshot, whole; the notification folded after it');
  // Each reducer step is one unit of fake time. No turn holds more than the budget plus the step that found it spent, and the
  // 125 row steps and 125 transcript-merge steps of 2000 items therefore take at least 250 / UNITS_PER_TURN turns.
  const steps = turn.all();
  assert.ok(Math.max(...steps) <= UNITS_PER_TURN, `a turn ran ${Math.max(...steps)} steps`);
  assert.ok(steps.filter((u) => u > 0).length >= Math.floor((2 * N) / 16 / UNITS_PER_TURN), `folded in ${steps.length} turns`);
});

test('a connection that ends mid-fold discards the staging: the thread keeps its previous state', async () => {
  const turn = new FakeTurn();
  const { conn, client, changes } = await setup(turn);
  conn.serverSend(notification('thread/snapshot', snapshotParams(bigItems(3)), 0));
  for (let i = 0; i < 5; i++) await tick();
  changes.length = 0;
  conn.serverSend(notification('thread/snapshot', snapshotParams(bigItems(2000)), 1));
  conn.serverClose(1006);
  for (let i = 0; i < 60; i++) await tick();
  assert.equal(items(client), 3);
  assert.equal(changes.some((c) => c.type === 'thread'), false);
});

test('a fold abandoned by a resubscribe never commits, whatever order the folds finish in', async () => {
  const turn = new FakeTurn();
  const { conn, client, changes } = await setup(turn);
  const old = { ...snapshotParams(bigItems(2000)), state: { title: 'old' } };
  conn.serverSendRaw(JSON.stringify(notification('thread/snapshot', old, 0)));
  await tick(); // the old snapshot is folding, yielding between steps

  const gone = client.unsubscribeThread('lead');
  conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result: {} });
  await gone;
  const again = client.resumeThread('lead', { lastItems: 50 });
  conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result: { thread, subscription: { id: 'sub2', mode: 'snapshot', epoch: 'e2', startSeq: 1 } } });
  await again;
  conn.serverSend({ method: 'thread/snapshot', params: { ...snapshotParams(bigItems(2)), state: { title: 'new' } }, feed: { id: 'lead', epoch: 'e2', seq: 0 } });
  for (let i = 0; i < 400; i++) await tick(); // long enough for the old fold to have finished, had it been allowed to

  const fold = client.store.thread('lead')!;
  assert.equal(fold.state.fields.desktopSessionTitle, 'new');
  assert.equal(fold.state.items.length, 2);
  assert.equal(fold.feed.epoch, 'e2');
  assert.equal(changes.filter((c) => c.type === 'thread').length, 1, 'only the current subscription committed');
});

test('an unsubscribe queued in a microtask at the fold completion still stops the commit', async () => {
  const turn = new FakeTurn();
  const hooks: { atCompletion?: () => void } = {};
  const { conn, client, changes } = await setup(turn, hooks);
  conn.serverSend({ ...notification('thread/snapshot', { ...snapshotParams(bigItems(3)), state: { title: 'old' } }, 0) });
  while (!client.store.thread('lead')) await tick();
  assert.equal(client.store.thread('lead')!.state.fields.desktopSessionTitle, 'old');
  changes.length = 0;

  // The next snapshot's generator finishes; in the microtask gap before the fold commits, the app unsubscribes.
  hooks.atCompletion = () => queueMicrotask(() => void client.unsubscribeThread('lead').catch(() => undefined));
  conn.serverSend(notification('thread/snapshot', { ...snapshotParams(bigItems(3)), state: { title: 'new' } }, 1));
  const unsubscribe = JSON.parse(await conn.nextSent());
  assert.equal(unsubscribe.method, 'thread/unsubscribe');
  conn.serverSend({ id: unsubscribe.id, result: {} });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(client.store.thread('lead'), undefined, 'the abandoned fold did not bring the thread back');
  assert.equal(changes.some((c) => c.type === 'thread'), false);
});

test('one very long run of finished tool calls aggregates in budgeted steps', async () => {
  const turn = new FakeTurn();
  const { conn, client } = await setup(turn);
  const N = 2000;
  const tools = Array.from({ length: N }, (_, i) => ({
    type: 'toolCall',
    id: `t${i}`,
    name: 'read',
    input: { path: `src/f${i}.ts` },
    output: `body ${i}`,
    meta: { status: 'completed', at: i },
  }));
  turn.reset();
  conn.serverSend(notification('thread/snapshot', snapshotParams(tools), 0));
  while (!client.store.thread('lead')) await tick();
  const state = client.store.thread('lead')!.state;
  assert.equal(state.items.length, N);
  const transcript = desktopSessionState(state, []).items as Array<{ name?: string; completedCount?: number }>;
  assert.deepEqual(transcript.map((r) => [r.name, r.completedCount]), [['__aggregate__', N]]);

  // Each reducer step is one unit of fake time. 2000 members are 125 quanta of 16, and eleven passes walk them: the rows, the scan
  // that groups them, the members' own work, and the finalization (counts, summaries, detail line, tool members, last diff,
  // loading targets, call ids, done categories, raw result). A pass that is not stepped drops its 125 from the total.
  const steps = turn.all();
  const total = steps.reduce((a, b) => a + b, 0);
  assert.ok(Math.max(...steps) <= UNITS_PER_TURN, `a turn ran ${Math.max(...steps)} steps`);
  assert.ok(total >= 11 * (Math.floor(N / 16) - 1), `${total} steps in all`);
});

