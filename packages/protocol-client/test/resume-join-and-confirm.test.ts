// One resume per thread while its snapshot is on the way (never a smaller window than asked), and a wake's question to the core.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const tick = () => new Promise<void>((r) => setImmediate(r));

async function setup() {
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  return { net, conn, client: await connecting };
}
let attaches = 0;
/** An attach answer. Each names a subscription of its own unless `held` names the one the core keeps (a carried resume). */
const reply = (
  id: number,
  mode: 'snapshot' | 'replay',
  epoch = 'te',
  startSeq = 1,
  liveSeq = startSeq,
  held = `s${++attaches}`
) => ({
  id,
  result: { subscription: { id: held, mode, epoch, startSeq, liveSeq } },
});

test('a joining resume of a thread whose snapshot is on the way sends nothing and is answered by the resume in flight', async () => {
  const { conn, client } = await setup();
  const first = client.resumeThread('t1', { lastItems: 50 });
  const resume = JSON.parse(await conn.nextSent());
  const joined = client.resumeThread('t1', { lastItems: 32 }, { join: true });
  await tick();
  assert.equal(conn.sent.length, 0, 'no second thread/resume');
  conn.serverSend(reply(resume.id, 'snapshot'));
  assert.equal(await joined, await first);
  // The reply is in but the snapshot is not folded: still nothing is sent for a window the first one holds.
  client.resumeThread('t1', { lastItems: 32 }, { join: true }).catch(() => undefined);
  await tick();
  assert.equal(conn.sent.length, 0);
  await client.close();
});

test('a join never yields less than it asked: a larger window is sent once the attach in flight has ended, never beside it, and a bigger one in flight answers a smaller ask', async () => {
  const { conn, client } = await setup();
  client.resumeThread('t1', { lastItems: 32 }).catch(() => undefined);
  const first = JSON.parse(await conn.nextSent());
  client.resumeThread('t1', { lastItems: 50 }, { join: true }).catch(() => undefined);
  await tick();
  assert.equal(conn.sent.length, 0, 'one attach of the thread is out at a time');
  conn.serverSend(reply(first.id, 'snapshot'));
  const grown = JSON.parse(await conn.nextSent());
  assert.deepEqual(grown.params.window, { lastItems: 50 }, 'the 50-item view is not answered by a 32-item prefetch');
  client.resumeThread('t1', { lastItems: 40 }, { join: true }).catch(() => undefined);
  await tick();
  assert.equal(conn.sent.length, 0, 'a 50-item resume in flight holds a 40-item ask');
  await client.close();
});

test('a replay leaves nothing to join: the next joining resume is sent', async () => {
  const { conn, client } = await setup();
  const first = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'replay'));
  await first;
  client.resumeThread('t1', { lastItems: 50 }, { join: true }).catch(() => undefined);
  await tick();
  assert.equal(conn.sent.length, 1);
  await client.close();
});

test('a replay remains pending until the last missed event folds, not just until its attach is answered', async (t) => {
  const { net, conn, client } = await setup();
  t.after(() => client.close());
  const initial = client.resumeThread('t1', { lastItems: 32 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot'));
  await initial;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  await tick();
  conn.serverClose(1006);
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent();
  const restore = JSON.parse(await again.nextSent());
  again.serverSend(reply(restore.id, 'replay', 'te', 1, 3));
  await tick();
  assert.equal(client.threadSubscription('t1').replayPending, true);
  const folds: { seq: number | undefined; complete: boolean; pending: boolean }[] = [];
  client.store.subscribe((change) => {
    if (change.type === 'thread')
      folds.push({
        seq: client.store.thread('t1')?.feed.seq,
        complete: change.replayComplete === true,
        pending: client.threadSubscription('t1').replayPending,
      });
  });
  for (const seq of [1, 2]) {
    again.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq } });
  }
  assert.equal(client.threadSubscription('t1').replayPending, true);
  await tick();
  assert.deepEqual(folds, [
    { seq: 1, complete: false, pending: true },
    { seq: 2, complete: true, pending: false },
  ]);
});

async function legacyThreadRestore() {
  const { net, conn, client } = await setup();
  const initial = client.resumeThread('t1', { lastItems: 32 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot'));
  await initial;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  await tick();
  conn.serverClose(1006);
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent();
  const restore = JSON.parse(await again.nextSent());
  again.serverSend({ id: restore.id, result: { subscription: { id: 's', mode: 'replay', epoch: 'te', startSeq: 1 } } });
  return { again, client };
}

test('a legacy replay waits for both the authoritative head and the fold through it', async (t) => {
  const { again, client } = await legacyThreadRestore();
  t.after(() => client.close());
  const complete: Array<number | undefined> = [];
  client.store.subscribe((change) => {
    if (change.type === 'thread' && change.replayComplete) complete.push(client.store.thread('t1')?.feed.seq);
  });
  const asked = JSON.parse(await again.nextSent());
  assert.deepEqual([asked.method, asked.params], ['feed/heads', { feedIds: ['t1'] }]);
  assert.equal(client.threadSubscription('t1').replayPending, true);
  again.serverSend({ id: asked.id, result: { positions: [{ epoch: 'te', seq: 2 }] } });
  again.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 1 } });
  await tick();
  assert.deepEqual(complete, []);
  assert.equal(client.threadSubscription('t1').replayPending, true);
  again.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 2 } });
  await tick();
  assert.deepEqual(complete, [2]);
  assert.equal(client.threadSubscription('t1').replayPending, false);
  assert.deepEqual(again.sent, [], 'a confirmed head needs no second attach');
});

test('a legacy peer without feed heads supplies the followed tail via a fresh snapshot, not an unconfirmed replay', async (t) => {
  const { again, client } = await legacyThreadRestore();
  t.after(() => client.close());
  const asked = JSON.parse(await again.nextSent());
  again.serverSend({ id: asked.id, error: { code: -32601, message: 'method not found' } });
  const recovery = JSON.parse(await again.nextSent());
  assert.deepEqual(
    [recovery.method, recovery.params],
    ['thread/resume', { threadId: 't1', window: { lastItems: 32 } }]
  );
  assert.equal(client.threadSubscription('t1').replayPending, true);
  again.serverSend(reply(recovery.id, 'snapshot', 'te', 2));
  await tick();
  assert.equal(client.threadSubscription('t1').snapshotPending, true);
  assert.equal(client.store.thread('t1')?.feed.seq, 0);
  again.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 1 } });
  await tick();
  assert.equal(client.threadSubscription('t1').snapshotPending, false);
  assert.equal(client.store.thread('t1')?.feed.seq, 1);
  assert.deepEqual(again.sent, []);
});

test('a transient legacy head failure recovers an idle followed thread with one fresh snapshot', async (t) => {
  const { again, client } = await legacyThreadRestore();
  t.after(() => client.close());
  const delivered: Array<number | undefined> = [];
  client.store.subscribe((change) => {
    if (
      change.type === 'thread' &&
      !client.threadSubscription('t1').replayPending &&
      !client.threadSubscription('t1').snapshotPending
    ) {
      delivered.push(client.store.thread('t1')?.feed.seq);
    }
  });

  const heads = JSON.parse(await again.nextSent());
  again.serverSend({ id: heads.id, error: { code: -32603, message: 'internal error' } });
  await tick();
  assert.equal(again.sent.length, 1, 'one recovery request, with no incoming thread events to wake it');
  const recovery = JSON.parse(await again.nextSent());
  assert.deepEqual(
    [recovery.method, recovery.params],
    ['thread/resume', { threadId: 't1', window: { lastItems: 32 } }]
  );
  assert.equal(client.threadSubscription('t1').replayPending, true);
  again.serverSend(reply(recovery.id, 'snapshot', 'te', 2));
  await tick();
  assert.deepEqual(delivered, [], 'the acknowledgement does not make the old fold live');
  again.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 1 } });
  await tick();
  assert.deepEqual(delivered, [1]);
  assert.deepEqual(again.sent, []);
});

test('a rejected legacy recovery reports loss and a later retry cannot reuse the stale cursor', async (t) => {
  const { again, client } = await legacyThreadRestore();
  t.after(() => client.close());
  const heads = JSON.parse(await again.nextSent());
  const refusal = { code: -32603, message: 'recovery failed' };
  again.serverSend({ id: heads.id, error: refusal });
  const recovery = JSON.parse(await again.nextSent());
  const states: string[] = [];
  client.store.subscribe((change) => {
    if (change.type === 'subscription' && change.feedId === 't1') states.push(change.state);
  });
  again.serverSend({ id: recovery.id, error: refusal });
  await tick();
  assert.deepEqual(states, ['lost']);
  assert.equal(client.threadSubscription('t1').followed, false);
  assert.ok(!client.store.thread('t1'));
  assert.deepEqual(again.sent, []);
  const retry = client.resumeThread('t1', { lastItems: 32 }, { follow: true });
  const next = JSON.parse(await again.nextSent());
  assert.deepEqual(next.params, { threadId: 't1', window: { lastItems: 32 } });
  again.serverSend(reply(next.id, 'snapshot', 'te', 2));
  await retry;
});

test('the automatic follow retries a refused turns window rather than substituting its item default', async () => {
  const { net, conn, client } = await setup();
  const initial = client.resumeThread('t1', { lastTurns: 18 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot'));
  await initial;
  conn.serverClose(1006);
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent();
  const restore = JSON.parse(await again.nextSent());
  const lost = new Promise<void>((resolve) => {
    const off = client.store.subscribe((c) => {
      if (c.type !== 'subscription' || c.feedId !== 't1' || c.state !== 'lost') return;
      off();
      resolve();
    });
  });
  again.serverSend({
    id: restore.id,
    error: { code: -32000, message: 'thread missing', data: { reason: 'threadNotFound' } },
  });
  await lost;
  const retry = client.resumeThread('t1', { lastItems: 50 }, { join: true, follow: true });
  const asked = JSON.parse(await again.nextSent());
  assert.deepEqual(asked.params.window, { lastTurns: 18 });
  again.serverSend(reply(asked.id, 'snapshot'));
  await retry;
  await client.close();
});

test('forced recovery sends a fresh resume when the acknowledged snapshot never arrived', async () => {
  const { conn, client } = await setup();
  const initial = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot'));
  await initial;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  await tick();

  const missing = client.resumeThread('t1', { lastItems: 50 });
  const request = JSON.parse(await conn.nextSent());
  assert.equal(request.params.resumeFrom.seq, 0);
  conn.serverSend(reply(request.id, 'snapshot', 'te', 2));
  await missing;

  const recovery = client.resumeThread('t1', { lastItems: 50 }, { force: true });
  await tick();
  const [fresh] = conn.sent.splice(0).map((text) => JSON.parse(text));
  assert.equal(fresh?.method, 'thread/resume');
  assert.deepEqual(fresh.params, { threadId: 't1', window: { lastItems: 50 } });
  conn.serverSend(reply(fresh.id, 'snapshot', 'te', 2));
  await recovery;
  await client.close();
});

test('an ordinary equal-window resume shares the outstanding reconnect restore and its departure', async () => {
  const { net, conn, client } = await setup();
  const initial = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot'));
  await initial;
  conn.serverClose(1006);
  const again = await net.accept();
  again.claims = 'held'; // the handshake frames carry no departure claim; the restore's does
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent(); // initialized
  const restoring = JSON.parse(await again.nextSent());
  let departed = false;
  const joined = client.resumeThread(
    't1',
    { lastItems: 50 },
    {
      sent: (sent) =>
        void sent.then(() => {
          departed = true;
        }),
    }
  );
  await tick();
  assert.equal(again.sent.length, 0);
  assert.equal(departed, false);
  again.releaseSent();
  await tick();
  assert.equal(departed, true);
  again.serverSend(reply(restoring.id, 'snapshot'));
  assert.equal((await joined).subscription.mode, 'snapshot');
  await client.close();
});

test('after a disconnect an acknowledged larger window whose snapshot never folded is not claimed as the held window', async () => {
  const { net, conn, client } = await setup();
  const small = client.resumeThread('t1', { lastItems: 32 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot'));
  await small;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  await tick();
  // The core acknowledges the 50-item window; its snapshot is never delivered before the link drops.
  const large = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot', 'te', 2));
  await large;
  conn.serverClose(1006);
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent(); // initialized
  const restore = JSON.parse(await again.nextSent());
  assert.equal(restore.method, 'thread/resume');
  assert.deepEqual(restore.params.window, { lastItems: 50 }, 'the restore still asks for what the caller wants');
  assert.deepEqual(
    restore.params.resumeFrom.window,
    { lastItems: 32 },
    'but claims the window the folded state was built from'
  );
  await client.close();
});

test("a held control thread's restore is the outstanding request an equal-window resume shares, with its actual departure", async () => {
  const { net, conn, client } = await setup();
  const started = client.call('thread/start', { kind: 'control' } as never);
  conn.serverSend({
    id: JSON.parse(await conn.nextSent()).id,
    result: {
      thread: { id: 'ctl' },
      subscription: { id: 's', mode: 'snapshot', epoch: 'ce', startSeq: 1, liveSeq: 1 },
    },
  });
  await started;
  conn.serverClose(1006);
  const again = await net.accept();
  // Frames written with a departure claim wait for `releaseSent`; the handshake frames carry none.
  again.claims = 'held';
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent(); // initialized
  const restore = JSON.parse(await again.nextSent());
  assert.deepEqual(
    [restore.method, restore.params.threadId, restore.params.window],
    ['thread/resume', 'ctl', { none: true }]
  );
  let departed = false;
  const joined = client.resumeThread(
    'ctl',
    { none: true },
    {
      sent: (sent) =>
        void sent.then(() => {
          departed = true;
        }),
    }
  );
  await tick();
  assert.equal(again.sent.length, 0, 'no second thread/resume');
  assert.equal(departed, false, 'the restore frame has not left');
  again.releaseSent();
  await tick();
  assert.equal(departed, true);
  again.serverSend(reply(restore.id, 'snapshot', 'ce', 1));
  assert.equal((await joined).subscription.mode, 'snapshot');
  await client.close();
});

test("a joiner observes the original request's actual departure, not the moment it joined", async () => {
  const { conn, client } = await setup();
  conn.claims = 'held';
  const departures: string[] = [];
  client
    .resumeThread('t1', { lastItems: 50 }, { sent: (p) => void p.then(() => departures.push('first')) })
    .catch(() => undefined);
  client
    .resumeThread('t1', { lastItems: 50 }, { join: true, sent: (p) => void p.then(() => departures.push('joiner')) })
    .catch(() => undefined);
  await tick();
  assert.deepEqual(departures, [], 'the frame has not left: neither is told it has');
  conn.releaseSent();
  await tick();
  assert.deepEqual(departures.sort(), ['first', 'joiner']);
  await client.close();
});

// A resume of a thread this connection already follows, in the same window, is answered by the subscription the core holds for it
// (server.rs `finish_subscribe`, `FeedSource::carries`): the decision is a replay after the folded position, the lane it already had
// delivers on, and no frame comes a second time. The answer and the lane's frames are written in either order.
test('a resume the core answers with the subscription it holds repeats nothing, and the feed runs on', async (t) => {
  const { conn, client } = await setup();
  t.after(() => client.close());
  const violations: string[] = [];
  client.on((e) => {
    if (e.type === 'protocolViolation') violations.push(e.what);
  });
  const frame = (seq: number) => ({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq } });
  const opened = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot', 'te', 1, 1, 'held'));
  await opened;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  conn.serverSend(frame(1));
  await tick();
  const folds: number[] = [];
  client.store.subscribe((change) => {
    if (change.type === 'thread') folds.push(client.store.thread('t1')!.feed.seq);
  });

  // A frame of the lane before the answer.
  const again = client.resumeThread('t1', { lastItems: 50 });
  const request = JSON.parse(await conn.nextSent());
  assert.equal(request.params.resumeFrom.seq, 1);
  conn.serverSend(frame(2));
  conn.serverSend(reply(request.id, 'replay', 'te', 2, 3, 'held'));
  conn.serverSend(frame(3));
  await again;
  await tick();
  assert.deepEqual(folds, [2, 3]);

  // The answer before the lane's frames up to the head it names.
  const third = client.resumeThread('t1', { lastItems: 50 });
  const later = JSON.parse(await conn.nextSent());
  assert.equal(later.params.resumeFrom.seq, 3);
  conn.serverSend(reply(later.id, 'replay', 'te', 4, 6, 'held'));
  conn.serverSend(frame(4));
  conn.serverSend(frame(5));
  await third;
  await tick();
  assert.deepEqual(violations, []);
  assert.deepEqual(folds, [2, 3, 4, 5], 'each event folds once, in order');

  // The feed is held to continuity throughout.
  conn.serverSend(frame(7));
  assert.deepEqual(violations, ['feed gap on t1']);
});

// Core write order (writer.rs) on a resume that attaches anew: the old lane's frames, the answer, then the replay `(resumeFrom.seq, S]` and live frames.
test('a replay that repeats frames the old subscription already delivered is not a gap, and nothing folds twice', async (t) => {
  const { conn, client } = await setup();
  t.after(() => client.close());
  const violations: string[] = [];
  client.on((e) => {
    if (e.type === 'protocolViolation') violations.push(e.what);
  });
  const opened = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot', 'te', 1));
  await opened;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 1 } });
  await tick();
  const folds: number[] = [];
  client.store.subscribe((change) => {
    if (change.type === 'thread') folds.push(client.store.thread('t1')!.feed.seq);
  });

  const again = client.resumeThread('t1', { lastItems: 50 });
  const request = JSON.parse(await conn.nextSent());
  assert.equal(request.params.resumeFrom.seq, 1);
  conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 2 } }); // the old lane, before the answer
  conn.serverSend(reply(request.id, 'replay', 'te', 2, 3));
  conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 2 } }); // the replay
  conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 3 } }); // live
  await again;
  await tick();
  assert.deepEqual(violations, []);
  assert.equal(conn.clientClose, undefined, 'the connection stays open');
  assert.deepEqual(folds, [2, 3], 'each event folds once, in order');
  assert.deepEqual(client.feedPosition('t1'), { epoch: 'te', seq: 3, order: client.feedPosition('t1')!.order });

  // After the repeated range the feed is held to continuity again.
  conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 5 } });
  assert.deepEqual(violations, ['feed gap on t1']);
});

test('a repeated range that a coalesced frame only partly covers is a gap', async (t) => {
  const { conn, client } = await setup();
  t.after(() => client.close());
  const violations: string[] = [];
  client.on((e) => {
    if (e.type === 'protocolViolation') violations.push(e.what);
  });
  const opened = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot', 'te', 1));
  await opened;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  await tick();
  const again = client.resumeThread('t1', { lastItems: 50 });
  const request = JSON.parse(await conn.nextSent());
  for (const seq of [1, 2])
    conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq } });
  conn.serverSend(reply(request.id, 'replay', 'te', 1, 3));
  conn.serverSend({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'te', seq: 1 } });
  assert.deepEqual(violations, []);
  conn.serverSend({ method: 'item/agentMessage/delta', params: {}, feed: { id: 't1', epoch: 'te', from: 2, seq: 3 } });
  assert.deepEqual(violations, ['feed gap on t1'], 'event 2 is folded already and 3 cannot be taken without it');
  await again.catch(() => undefined);
});

async function attachedFeeds() {
  const { conn, client } = await setup();
  const app = client.subscribeApp();
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot', 'ae', 1));
  await app;
  conn.serverSend({ method: 'app/snapshot', params: { sections: [] }, feed: { id: 'app', epoch: 'ae', seq: 0 } });
  const thread = client.resumeThread('t1', { lastItems: 50 });
  conn.serverSend(reply(JSON.parse(await conn.nextSent()).id, 'snapshot', 'te', 1));
  await thread;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'te', seq: 0 } });
  await tick();
  return { conn, client };
}
const answerHeads = async (
  conn: Awaited<ReturnType<typeof setup>>['conn'],
  positions: Array<{ epoch: string; seq: number } | null>,
  feedIds = ['app', 't1']
) => {
  const asked = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: asked.id, result: { feedIds, positions } });
  return asked;
};

test('a wake checks every feed in one core request and matching positions need no further request', async () => {
  const { conn, client } = await attachedFeeds();
  const confirming = client.confirmFeeds(['app', 't1']);
  const asked = await answerHeads(conn, [
    { epoch: 'ae', seq: 0 },
    { epoch: 'te', seq: 0 },
  ]);
  assert.equal(asked.method, 'feed/heads');
  assert.deepEqual(asked.params, {});
  assert.equal(await confirming, true);
  assert.equal(conn.sent.length, 0);
  await client.close();
});

test('wake cannot miss the final update on a terminal feed subscribed independently of the view', async () => {
  const { conn, client } = await attachedFeeds();
  const subscribed = client.call('feed/subscribe', { feedId: 'process:relay' });
  const sub = JSON.parse(await conn.nextSent());
  conn.serverSend(reply(sub.id, 'snapshot', 'terminal'));
  await subscribed;
  conn.serverSend({
    method: 'feed/snapshot',
    params: { feedId: 'process:relay', state: {} },
    feed: { id: 'process:relay', epoch: 'terminal', seq: 0 },
  });
  const feeds = ['app', 't1', 'process:relay'];
  const heads = [
    { epoch: 'ae', seq: 0 },
    { epoch: 'te', seq: 0 },
  ];
  const healthy = client.confirmFeeds(['app', 't1']);
  await answerHeads(conn, [...heads, { epoch: 'terminal', seq: 0 }], feeds);
  assert.equal(await healthy, true);
  const missed = client.confirmFeeds(['app', 't1']);
  await answerHeads(conn, [...heads, { epoch: 'terminal', seq: 1 }], feeds);
  assert.equal(await missed, false);
  await client.close();
});

test('a thread that missed its final update and then went quiet is not confirmed', async () => {
  const { conn, client } = await attachedFeeds();
  const confirming = client.confirmFeeds(['app', 't1']);
  assert.equal(client.feedPosition('t1')?.seq, 0, 'the client still has a local position');
  await answerHeads(conn, [
    { epoch: 'ae', seq: 0 },
    { epoch: 'te', seq: 1 },
  ]);
  assert.equal(await confirming, false);
  await client.close();
});

test('an epoch change or a missing subscription prevents confirmation', async () => {
  const { conn, client } = await attachedFeeds();
  const confirming = client.confirmFeeds(['app', 't1']);
  await answerHeads(conn, [
    { epoch: 'ae', seq: 0 },
    { epoch: 'te2', seq: 0 },
  ]);
  assert.equal(await confirming, false);
  const missing = client.confirmFeeds(['app']);
  await answerHeads(conn, [], []);
  assert.equal(await missing, false);
  await client.close();
});
