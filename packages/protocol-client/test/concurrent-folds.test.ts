// Folds that run at once share the loop's turns (`ConnectOptions.turn`). The test owns the loop: a yield request only queues, and
// `release()` is the loop turn that answers every request queued so far. Reducer work is charged in fake time (`now()` charges
// nothing), so what a turn spent is the fake time between its release and the end of everything it ran, whatever the number of
// yield requests. Nothing here waits a fixed time: the fixture is promises only, so everything a turn set running has finished when
// a whole macrotask passes without a unit of work, a yield request or a client frame.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const macrotask = () => new Promise<void>((r) => setImmediate(r));
const FOLDS = 4;
const STEPS = 30;
/** The blob scan asks the budget at every 64th node it visits (`visited & 63`): a 128-element array crosses that at least once. */
const PAD = 128;
/** A fold's units of work: its steps, the check that finds the reducer done, and at most this many asks of the blob scan. */
const SCAN_ASKS = 3;
// A test that never settles is a failure, not a hang.
const DEADLINE = { timeout: 20_000 };
const thread = (id: string) => ({ id, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null });
const snapshot = (id: string, epoch: string, seq: number, pad: number) => ({
  method: 'thread/snapshot',
  params: { thread: thread(id), items: [], state: { title: 'T' }, hasOlder: false, padding: Array.from({ length: pad }, (_, i) => i) },
  feed: { id, epoch, seq },
});

interface Turn {
  /** Fake time everything the turn ran spent. */
  spent: number;
  /** Steps taken in it, by fold. */
  steps: string[];
  /** Folds that finished in it. */
  finished: number;
}

interface Config {
  budgetMs: number;
  stepMs: number;
  steps?: number;
  /** Elements of the array in every snapshot's params, which the blob scan visits. */
  pad?: number;
  /** Every 
ow() call advances the clock by 1 ms (on top of the reducer's charges), so a turn's second ask always finds the budget of 0 spent. */
  advancing?: boolean;
  /** The first yield request throws synchronously instead of returning a promise. */
  throwFirstYield?: boolean;
}

async function harness(config: Config) {
  const steps = config.steps ?? STEPS;
  const pad = config.pad ?? 0;
  let t = 0;
  let turnNo = -1;
  let activity = 0;
  let throwNext = config.throwFirstYield === true;
  const requests: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  /** Every step of every fold, and each fold's finish: its fold and the released turn it ran in (-1: before the first release). */
  const log: Array<{ id: string; turn: number; done?: true }> = [];
  const reducer: typeof sessionReducer = {
    ...sessionReducer,
    *initialSteps(params) {
      const id = (params as unknown as { thread: { id: string } }).thread.id;
      for (let i = 0; i < steps; i++) {
        activity++;
        t += config.stepMs;
        log.push({ id, turn: turnNo });
        yield;
      }
      activity++;
      log.push({ id, turn: turnNo, done: true });
      return sessionReducer.initial(params);
    },
  };
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: reducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
    turn: {
      budgetMs: config.budgetMs,
      now: () => (config.advancing ? ++t : t),
      yieldTurn: () => {
        activity++;
        if (throwNext) {
          throwNext = false;
          throw new Error('no loop');
        }
        return new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
      },
    },
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const ids = Array.from({ length: FOLDS }, (_, i) => `t${i}`);
  for (const id of ids) {
    const resumed = client.resumeThread(id, { lastItems: 50 });
    const req = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: req.id, result: { thread: thread(id), subscription: { id: `sub-${id}`, mode: 'snapshot', epoch: 'e1', startSeq: 1 } } });
    await resumed;
  }
  /** Until a macrotask passes with nothing done: every microtask chain the last step set off has run out. */
  const settle = async () => {
    for (let seen = -1; seen !== activity; ) {
      seen = activity;
      await macrotask();
    }
  };
  /** One socket read: every session's snapshot arrives in the same loop turn, so the folds start together. `spendBeforeScan`
   *  is fake time that passes before any fold's blob scan runs (they run in microtasks, after this synchronous read). */
  const startAll = async (spendBeforeScan = 0, only = ids) => {
    only.forEach((id) => conn.serverSend(snapshot(id, 'e1', 0, pad)));
    t += spendBeforeScan;
    await settle();
  };
  /** The app feed: subscribes, and delivers an app snapshot of count sections; with `lastIsStub`, the last is a section the
   *  server left as a stub (no value to resolve). */
  const startApp = async (count: number, lastIsStub = false) => {
    const subscribed = client.subscribeApp();
    const sub = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: sub.id, result: { subscription: { id: 'as', mode: 'snapshot', epoch: 'ae', startSeq: 1 } } });
    await subscribed;
    const sections = Array.from({ length: count }, (_, i) => ({
      section: 'agents',
      key: `k${i}`,
      revision: 1,
      ...(lastIsStub && i === count - 1 ? { stub: { count: 1, stub: true } } : { value: i }),
    }));
    conn.serverSend({ method: 'app/snapshot', params: { sections }, feed: { id: 'app', epoch: 'ae', seq: 0 } });
    await settle();
  };
  /** One loop turn: answers every yield request queued so far (a loop turn runs all the immediates queued before it) and lets
   *  everything they set running finish. */
  const release = async (): Promise<Turn | null> => {
    const asked = requests.splice(0);
    if (asked.length === 0) return null;
    const from = t;
    const before = log.length;
    turnNo++;
    for (const request of asked) request.resolve();
    await settle();
    const ran = log.slice(before);
    return { spent: t - from, steps: ran.filter((s) => !s.done).map((s) => s.id), finished: ran.filter((s) => s.done).length };
  };
  /** Turns until nobody asks for one. Every turn runs at least one unit of work, so a run of `units` units takes at most that
   *  many turns: more is a turn that advanced nothing. */
  const drain = async (units: number) => {
    const turns: Turn[] = [];
    for (let turn = await release(); turn; turn = await release()) {
      turns.push(turn);
      assert.ok(turns.length <= units, `${turns.length} turns for ${units} units of work`);
    }
    return turns;
  };
  const stepsOf = (id: string) => log.filter((s) => s.id === id && !s.done);
  const unitsOf = (perFold: number) => FOLDS * (perFold + 1 + SCAN_ASKS);
  /** The link dropped because the waiting folds failed: the client dials again, and every session is resumed on it. Serves that
   *  connection, then lets the sessions re-attach (answers their resume with a snapshot), and returns when all have asked. */
  const reattach = async () => {
    const next = await net.accept();
    const resumed = new Set<string>();
    let allResumed!: () => void;
    const all = new Promise<void>((r) => (allResumed = r));
    void (async () => {
      for (;;) {
        const frame = JSON.parse(await next.nextSent());
        if (frame.method === 'initialize') next.serverSend({ id: frame.id, result: { ...options.initializeResult, serverInstanceId: 's2' } });
        else if (frame.method === 'thread/resume') {
          const id = frame.params.threadId as string;
          next.serverSend({ id: frame.id, result: { thread: thread(id), subscription: { id: `sub2-${id}`, mode: 'snapshot', epoch: 'e2', startSeq: 1 } } });
          next.serverSend(snapshot(id, 'e2', 0, pad));
          resumed.add(id);
          if (resumed.size === FOLDS) allResumed();
        } else if (frame.id !== undefined) next.serverSend({ id: frame.id, result: {} });
      }
    })();
    await all;
    assert.deepEqual([...resumed].sort(), ids, 'every session re-attached');
    await settle();
  };
  return { net, conn, client, ids, requests, log, turnNo: () => turnNo, startAll, startApp, release, drain, settle, stepsOf, unitsOf, reattach, steps };
}

/** Per released turn: the turn spent at most one budget plus the longest step, and ran at least one unit. */
function assertTurns(turns: Turn[], budgetMs: number, stepMs: number): void {
  turns.forEach((turn, i) => {
    assert.ok(turn.steps.length + turn.finished >= 1, `turn ${i} advanced no fold`);
    assert.ok(turn.spent <= budgetMs + stepMs, `turn ${i} spent ${turn.spent} ms (limit ${budgetMs + stepMs}): ${turn.steps.join(',')}`);
  });
}

test('concurrent folds share one budget per loop turn, and each advances within a bounded number of turns', DEADLINE, async () => {
  const h = await harness({ budgetMs: 8, stepMs: 1 });
  await h.startAll();
  const turns = await h.drain(h.unitsOf(STEPS));
  assertTurns(turns, 8, 1);
  for (const id of h.ids) {
    const at = [-1, ...h.stepsOf(id).map((s) => s.turn)];
    assert.equal(h.stepsOf(id).length, STEPS, `${id} finished`);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! <= FOLDS, `${id} waited ${at[i]! - at[i - 1]!} turns`);
  }
  assert.ok(turns.length <= Math.ceil((FOLDS * STEPS) / 8) + FOLDS, `${turns.length} turns for ${FOLDS * STEPS} steps`);
});

test('steps longer than the budget run one step per turn, not one per fold', DEADLINE, async () => {
  const h = await harness({ budgetMs: 8, stepMs: 9, steps: 6 });
  await h.startAll();
  const turns = await h.drain(h.unitsOf(6));
  assertTurns(turns, 8, 9);
  assert.ok(turns.every((turn) => turn.steps.length <= 1), `steps per turn: ${turns.map((turn) => turn.steps.length).join(',')}`);
  for (const id of h.ids) assert.equal(h.stepsOf(id).length, 6, `${id} finished`);
});

test('folds that resume inside the blob scan share the turn too: 9 ms steps on an 8 ms budget run one step', DEADLINE, async () => {
  const h = await harness({ budgetMs: 8, stepMs: 9, steps: 6, pad: PAD });
  // The budget is spent before any scan runs: every fold waits inside its scan, not in its reducer.
  await h.startAll(9);
  assert.equal(h.log.length, 0, 'no fold reached its reducer before the first turn');
  const first = await h.release();
  assert.ok(first, 'the folds asked for a turn');
  assert.equal(first.steps.length, 1, `the first turn ran ${first.steps.length} steps`);
  assert.ok(first.spent <= 8 + 9, `the first turn spent ${first.spent} ms`);
  const turns = await h.drain(h.unitsOf(6));
  assertTurns(turns, 8, 9);
  assert.ok(turns.every((turn) => turn.steps.length <= 1), `steps per turn: ${turns.map((turn) => turn.steps.length).join(',')}`);
  for (const id of h.ids) assert.equal(h.stepsOf(id).length, 6, `${id} finished`);
});

test('with a budget of 0 every turn still advances one fold', DEADLINE, async () => {
  const h = await harness({ budgetMs: 0, stepMs: 1, steps: 6 });
  await h.startAll();
  const turns = await h.drain(h.unitsOf(6));
  assertTurns(turns, 0, 1);
  assert.ok(turns.every((turn) => turn.steps.length <= 1), `steps per turn: ${turns.map((turn) => turn.steps.length).join(',')}`);
  for (const id of h.ids) assert.equal(h.stepsOf(id).length, 6, `${id} finished`);
});

test('a fold cancelled while it waits does not stop the others', DEADLINE, async () => {
  const h = await harness({ budgetMs: 8, stepMs: 1 });
  await h.startAll();
  await h.release();
  const unsubscribed = h.client.unsubscribeThread('t0');
  const req = JSON.parse(await h.conn.nextSent());
  h.conn.serverSend({ id: req.id, result: {} });
  await unsubscribed;
  const stepsBefore = h.stepsOf('t0').length;
  const turns = await h.drain(h.unitsOf(STEPS));
  assertTurns(turns, 8, 1);
  for (const id of h.ids.slice(1)) assert.equal(h.stepsOf(id).length, STEPS, `${id} finished`);
  assert.ok(h.stepsOf('t0').length - stepsBefore <= 1, 'the cancelled fold stopped at its next turn');
});

test('an app snapshot fold and a thread reducer alternate: neither waits more than one turn of the other between two of its units', DEADLINE, async () => {
  const SECTIONS = 32;
  const THREAD_STEPS = 12;
  const h = await harness({ budgetMs: 0, stepMs: 1, steps: THREAD_STEPS, advancing: true });
  // The thread reducer is queued first, then the app snapshot arrives while it is waiting.
  await h.startAll(0, ['t0']);
  await h.startApp(SECTIONS);
  // The budget is 0 and the clock advances on every ask, so each turn holds one unit of work, the thread's (a step, or its finish)
  // or the app fold's (staging a section, announcing it): a turn the thread did not run in belongs to the app.
  const turns = await h.drain(THREAD_STEPS + 1 + SECTIONS * (2 + SCAN_ASKS) + 2);
  const lastThread = turns.findLastIndex((turn) => turn.steps.length + turn.finished > 0);
  assert.equal(h.stepsOf('t0').length, THREAD_STEPS, 'the thread finished');
  assert.ok(lastThread >= THREAD_STEPS - 2, 'the thread ran across the turns');
  const threadRan = turns.slice(0, lastThread + 1).map((turn) => turn.steps.length + turn.finished > 0);
  for (let i = 1; i < threadRan.length; i++) {
    assert.notEqual(threadRan[i], threadRan[i - 1], `turns ${i - 1} and ${i} went to the ${threadRan[i] ? 'thread' : 'app fold'} both times: ${threadRan.map((r) => (r ? 'T' : 'A')).join('')}`);
  }
});

test('an app fold that goes from staging to announcing keeps its turn order beside a thread fold that is still waiting', DEADLINE, async () => {
  const THREAD_STEPS = 12;
  const h = await harness({ budgetMs: 0, stepMs: 1, steps: THREAD_STEPS, advancing: true });
  let announcedAt = -1;
  h.client.store.subscribe((change) => {
    if (change.type === 'appSnapshot') announcedAt = h.turnNo();
  });
  await h.startAll(0, ['t0']);
  // The last section is a stub (no value to resolve), so the fold goes from staging its last section into announcing in one
  // synchronous run, with no await of its own between them.
  await h.startApp(2, true);
  const turns = await h.drain(THREAD_STEPS + 1 + 2 * (2 + SCAN_ASKS) + 2);
  assert.equal(h.stepsOf('t0').length, THREAD_STEPS, 'the thread finished');
  assert.ok(announcedAt >= 0 && announcedAt < turns.length - 1, `the app fold finished (turn ${announcedAt}) while the thread was still running`);
  // Every turn the app fold was active, up to and including its last announcement, went to one fold or the other in turn.
  const threadRan = turns.slice(0, announcedAt + 1).map((turn) => turn.steps.length + turn.finished > 0);
  for (let i = 1; i < threadRan.length; i++) {
    assert.notEqual(threadRan[i], threadRan[i - 1], `turns ${i - 1} and ${i} went to the ${threadRan[i] ? 'thread' : 'app fold'} both times: ${threadRan.map((r) => (r ? 'T' : 'A')).join('')}`);
  }
});

/** The waiting folds failed: the link dropped, and the folds that come after it still get turns and finish. */
async function assertRecovered(h: Awaited<ReturnType<typeof harness>>) {
  const before = h.log.length;
  await h.reattach();
  const turns = await h.drain(h.unitsOf(h.steps));
  assertTurns(turns, 8, 1);
  for (const id of h.ids) assert.equal(h.log.slice(before).filter((s) => s.id === id && !s.done).length, h.steps, `${id} folded after the failure`);
}

test('a rejected yieldTurn fails the waiting folds, and later folds still get turns', DEADLINE, async () => {
  const h = await harness({ budgetMs: 8, stepMs: 1 });
  await h.startAll();
  assert.ok(h.requests.length >= 1, 'the waiting folds asked for a turn');
  for (const request of h.requests.splice(0)) request.reject(new Error('no loop'));
  await assertRecovered(h);
});

test('a yieldTurn that throws synchronously fails the waiting folds, and later folds still get turns', DEADLINE, async () => {
  const h = await harness({ budgetMs: 8, stepMs: 1, throwFirstYield: true });
  await h.startAll();
  await assertRecovered(h);
});








