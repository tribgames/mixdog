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
const reply = (id: number, mode: 'snapshot' | 'replay', epoch = 'te', startSeq = 1, liveSeq = startSeq) => ({ id, result: { subscription: { id: 's', mode, epoch, startSeq, liveSeq } } });

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

test('a join never yields less than it asked: a larger window than the one in flight is sent, and a bigger one in flight answers a smaller ask', async () => {
  const { conn, client } = await setup();
  client.resumeThread('t1', { lastItems: 32 }).catch(() => undefined);
  await conn.nextSent();
  client.resumeThread('t1', { lastItems: 50 }, { join: true }).catch(() => undefined);
  await tick();
  const sent = conn.sent.map((text) => JSON.parse(text));
  assert.equal(sent.length, 1, 'the 50-item view is not answered by a 32-item prefetch');
  assert.deepEqual(sent[0].params.window, { lastItems: 50 });
  conn.sent.length = 0;
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
  again.serverSend({ id: restore.id, error: { code: -32000, message: 'thread missing', data: { reason: 'threadNotFound' } } });
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
  const joined = client.resumeThread('t1', { lastItems: 50 }, { sent: (sent) => void sent.then(() => { departed = true; }) });
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
  assert.deepEqual(restore.params.resumeFrom.window, { lastItems: 32 }, 'but claims the window the folded state was built from');
  await client.close();
});

test('a held control thread\'s restore is the outstanding request an equal-window resume shares, with its actual departure', async () => {
  const { net, conn, client } = await setup();
  const started = client.call('thread/start', { kind: 'control' } as never);
  conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result: { thread: { id: 'ctl' }, subscription: { id: 's', mode: 'snapshot', epoch: 'ce', startSeq: 1, liveSeq: 1 } } });
  await started;
  conn.serverClose(1006);
  const again = await net.accept();
  // Frames written with a departure claim wait for `releaseSent`; the handshake frames carry none.
  again.claims = 'held';
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent(); // initialized
  const restore = JSON.parse(await again.nextSent());
  assert.deepEqual([restore.method, restore.params.threadId, restore.params.window], ['thread/resume', 'ctl', { none: true }]);
  let departed = false;
  const joined = client.resumeThread('ctl', { none: true }, { sent: (sent) => void sent.then(() => { departed = true; }) });
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

test('a joiner observes the original request\'s actual departure, not the moment it joined', async () => {
  const { conn, client } = await setup();
  conn.claims = 'held';
  const departures: string[] = [];
  client.resumeThread('t1', { lastItems: 50 }, { sent: (p) => void p.then(() => departures.push('first')) }).catch(() => undefined);
  client.resumeThread('t1', { lastItems: 50 }, { join: true, sent: (p) => void p.then(() => departures.push('joiner')) }).catch(() => undefined);
  await tick();
  assert.deepEqual(departures, [], 'the frame has not left: neither is told it has');
  conn.releaseSent();
  await tick();
  assert.deepEqual(departures.sort(), ['first', 'joiner']);
  await client.close();
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
const answerHeads = async (conn: Awaited<ReturnType<typeof setup>>['conn'], positions: Array<{ epoch: string; seq: number } | null>, feedIds = ['app', 't1']) => {
  const asked = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: asked.id, result: { feedIds, positions } });
  return asked;
};

test('a wake checks every feed in one core request and matching positions need no further request', async () => {
  const { conn, client } = await attachedFeeds();
  const confirming = client.confirmFeeds(['app', 't1']);
  const asked = await answerHeads(conn, [{ epoch: 'ae', seq: 0 }, { epoch: 'te', seq: 0 }]);
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
  conn.serverSend({ method: 'feed/snapshot', params: { feedId: 'process:relay', state: {} }, feed: { id: 'process:relay', epoch: 'terminal', seq: 0 } });
  const feeds = ['app', 't1', 'process:relay'];
  const heads = [{ epoch: 'ae', seq: 0 }, { epoch: 'te', seq: 0 }];
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
  await answerHeads(conn, [{ epoch: 'ae', seq: 0 }, { epoch: 'te', seq: 1 }]);
  assert.equal(await confirming, false);
  await client.close();
});

test('an epoch change or a missing subscription prevents confirmation', async () => {
  const { conn, client } = await attachedFeeds();
  const confirming = client.confirmFeeds(['app', 't1']);
  await answerHeads(conn, [{ epoch: 'ae', seq: 0 }, { epoch: 'te2', seq: 0 }]);
  assert.equal(await confirming, false);
  const missing = client.confirmFeeds(['app']);
  await answerHeads(conn, [], []);
  assert.equal(await missing, false);
  await client.close();
});
