// What a window keeps when the connection is not simply up: a first connection that fails is tried again, a call has a time
// limit, a refused restore is not a lost conversation, a pending approval is back after a reconnect, a throwing listener
// does not silence the others. Every wait is on the mock transport's own signal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { type MockConn, MockNetwork } from '../src/mock.ts';
import type { ConnectOptions } from '../src/api.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const attached = { subscription: { epoch: 'e1', startSeq: 1 } };

const rig = (extra: Partial<ConnectOptions> = {}) => {
  const net = new MockNetwork();
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const waiting = new Map<string, Array<() => void>>();
  const line = (event: string): Promise<void> =>
    new Promise((resolve) => waiting.set(event, [...(waiting.get(event) ?? []), resolve]));
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => options.jitterUnit,
    ladder: options.ladder,
    onDiagnostic: (event, fields) => {
      lines.push({ event, fields });
      for (const resolve of waiting.get(event)?.splice(0) ?? []) resolve();
    },
    ...extra,
  });
  /** Answers `initialize` of the next connection; `then` runs between its reply and the `initialized` notification. */
  const handshake = async (then?: (conn: MockConn) => void): Promise<MockConn> => {
    const conn = await net.accept();
    const init = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } });
    then?.(conn);
    await conn.nextSent();
    return conn;
  };
  return { net, connecting, handshake, line, of: (event: string) => lines.filter((l) => l.event === event) };
};

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const follow = async (client: Awaited<ReturnType<typeof connect>>, conn: MockConn, threadId: string) => {
  const resumed = client.resumeThread(threadId, { lastItems: 5 });
  const resume = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: resume.id, result: attached });
  await resumed;
};

test('a first connection that fails is tried again on the ladder until it comes up', async () => {
  const r = rig({ firstConnectDeadlineMs: 60_000 });
  r.net.failNext = 2;
  await r.handshake();
  const client = await r.connecting;
  assert.equal(client.status.state, 'ready');
  await client.close();
});

test('a version refusal before the first connection is not tried again', async () => {
  const r = rig({ firstConnectDeadlineMs: 60_000 });
  const conn = await r.net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({
    id: init.id,
    error: { code: -32600, message: 'old', data: { reason: 'clientOutdated', serverVersion: '2', clientVersion: '1' } },
  });
  await assert.rejects(
    r.connecting,
    (error: { detail?: { kind?: string } }) => error.detail?.kind === 'versionRefused'
  );
});

test('a deadline the caller passes on purpose fails a sent read, and the late answer is no protocol violation', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const read = client.call('thread/read', { threadId: 't1', window: { lastItems: 1 } }, { timeoutMs: 30 });
  const frame = JSON.parse(await conn.nextSent());
  await assert.rejects(
    read,
    (error: { detail?: { kind?: string; sent?: boolean } }) =>
      error.detail?.kind === 'requestTimeout' && error.detail.sent === true
  );
  conn.serverSend({ id: frame.id, result: { thread: { id: 't1' } } });
  assert.equal(conn.clientClose, undefined, 'the connection stays open');
  assert.equal(client.status.state, 'ready');
  await client.close();
});

test("a mutation whose request was out when the caller's own deadline passed fails as an unknown outcome", async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const pending = client.call('thread/delete', { threadId: 't1' }, { timeoutMs: 30 });
  await conn.nextSent();
  await assert.rejects(
    pending,
    (error: { detail?: { kind?: string; cause?: { kind?: string } } }) =>
      error.detail?.kind === 'opOutcomeUnknown' && error.detail.cause?.kind === 'requestTimeout'
  );
  await client.close();
});

test('a call that waits for a connection that never comes back fails at its pre-send bound and never leaves afterwards', async () => {
  const r = rig({ requestTimeoutMs: 30 });
  const first = await r.handshake();
  const client = await r.connecting;
  first.serverClose(1006);
  const pending = client.call('thread/delete', { threadId: 't1' });
  await assert.rejects(
    pending,
    (error: { detail?: { kind?: string; sent?: boolean } }) =>
      error.detail?.kind === 'requestTimeout' && error.detail.sent === false
  );
  const reconnected = r.line('link-reconnected');
  const second = await r.handshake();
  await reconnected;
  assert.equal(second.sent.length, 0, 'nothing is sent for the failed call');
  await client.close();
});

test('a restore the core refuses for a passing reason is tried again, not given up as a lost conversation', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  await follow(client, first, 't1');
  const lost: unknown[] = [];
  client.on((event) => event.type === 'subscriptionLost' && lost.push(event));
  first.serverClose(1006);
  const second = await r.handshake();
  const settled = r.line('link-restore-settled');
  const refused = JSON.parse(await second.nextSent());
  second.serverSend({
    id: refused.id,
    error: { code: -32603, message: 'busy', data: { reason: 'internal', incidentId: 'x' } },
  });
  const again = JSON.parse(await second.nextSent());
  assert.equal(again.method, 'thread/resume');
  second.serverSend({ id: again.id, result: attached });
  await settled;
  assert.equal(r.of('link-restore-settled')[0]!.fields.threadsRestored, 1);
  assert.deepEqual(lost, []);
  await client.close();
});

test('a restore the core refuses because the thread is gone still drops the subscription', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  await follow(client, first, 't1');
  first.serverClose(1006);
  const second = await r.handshake();
  const settled = r.line('link-restore-settled');
  const refused = JSON.parse(await second.nextSent());
  second.serverSend({
    id: refused.id,
    error: { code: -32600, message: 'gone', data: { reason: 'threadNotFound', threadId: 't1' } },
  });
  await settled;
  assert.equal(r.of('link-restore-settled')[0]!.fields.threadsLost, 1);
  await client.close();
});

test('a restore a busy core answers late keeps its live connection and restores the subscription', async (t) => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  await follow(client, first, 't1');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  first.serverClose(1006);
  const second = await r.handshake();
  const settled = r.line('link-restore-settled');
  const resume = JSON.parse(await second.nextSent());
  assert.equal(resume.method, 'thread/resume');
  t.mock.timers.tick(11_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.clientClose, undefined, 'the connection is not dropped while its restore is answered late');
  const restored = new Promise<unknown>((resolve) =>
    client.store.subscribe((change) => {
      if (change.type === 'subscription' && change.feedId === 't1') resolve(change.state);
    })
  );
  second.serverSend({ id: resume.id, result: attached });
  await settled;
  assert.equal(await restored, 'restored', 'the late answer restores the subscription');
  assert.equal(client.threadSubscription('t1').followed, true);
  await client.close();
});

test("a resume that joins an unanswered restore ends at the joiner's own bound", async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  await follow(client, first, 't1');
  first.serverClose(1006);
  const second = await r.handshake();
  assert.equal(JSON.parse(await second.nextSent()).method, 'thread/resume');
  const joined = client.resumeThread('t1', { lastItems: 5 }, { join: true, timeoutMs: 30 });
  await assert.rejects(
    joined,
    (error: { detail?: { kind?: string; sent?: boolean } }) =>
      error.detail?.kind === 'requestTimeout' && error.detail.sent === true
  );
  assert.equal(second.clientClose, undefined, 'the connection stays open');
  await client.close();
});

/** Opens `t1` against an older core (a replay with no live boundary) up to the fallback snapshot resume it needs; returns that request. */
const openToFallback = async (client: Awaited<ReturnType<typeof connect>>, conn: MockConn, signal?: AbortSignal) => {
  const opening = client.resumeThread('t1', { lastItems: 5 }, { join: true, follow: true, signal });
  const resume = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: resume.id, result: { subscription: { epoch: 'e1', startSeq: 1, mode: 'replay' } } });
  const heads = JSON.parse(await conn.nextSent());
  assert.equal(heads.method, 'feed/heads');
  conn.serverSend({ id: heads.id, result: { feedIds: ['t1'], positions: [{ epoch: 'e2', seq: 4 }] } });
  const fallback = JSON.parse(await conn.nextSent());
  assert.equal(fallback.method, 'thread/resume');
  return { opening, fallback };
};
const snapshotAt = { subscription: { epoch: 'e2', startSeq: 5, liveSeq: 5, mode: 'snapshot' } };

test('a legacy replay whose fallback snapshot is never answered ends as a lost thread when its watch ends the wait', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const watch = new AbortController();
  const lost: unknown[] = [];
  client.on((event) => event.type === 'subscriptionLost' && lost.push(event.threadId));
  const { opening } = await openToFallback(client, conn, watch.signal);
  assert.equal(client.threadSubscription('t1').replayPending, true);
  watch.abort();
  await assert.rejects(opening, (error: { detail?: { kind?: string } }) => error.detail?.kind === 'requestTimeout');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lost, ['t1'], 'the user is told the thread was lost and can retry');
  assert.equal(client.threadSubscription('t1').replayPending, false);
  await client.close();
});

test('a retry after an abandoned legacy fallback sends its own request, and the late answer to the abandoned one changes nothing', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const watch = new AbortController();
  const lost = new Promise<void>((resolve) => client.on((event) => event.type === 'subscriptionLost' && resolve()));
  const { opening, fallback } = await openToFallback(client, conn, watch.signal);
  watch.abort();
  await assert.rejects(opening, (error: { detail?: { kind?: string } }) => error.detail?.kind === 'requestTimeout');
  await lost;
  assert.equal(client.threadSubscription('t1').snapshotPending, false, 'nothing of the abandoned open is left to join');

  let retried: 'followed' | 'failed' | undefined;
  const retry = client.resumeThread('t1', { lastItems: 5 }, { join: true, follow: true });
  retry.then(
    () => (retried = 'followed'),
    () => (retried = 'failed')
  );
  const again = JSON.parse(await conn.nextSent());
  assert.equal(again.method, 'thread/resume', 'the retry is a request of its own');
  assert.notEqual(again.id, fallback.id);
  assert.equal(again.params.resumeFrom, undefined, 'and offers no cursor of the lost thread');

  conn.serverSend({ id: fallback.id, result: snapshotAt });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retried, undefined, 'the abandoned request does not answer the retry');
  assert.equal(client.threadSubscription('t1').followed, false);
  assert.equal(conn.clientClose, undefined);

  conn.serverSend({ id: again.id, result: snapshotAt });
  await retry;
  assert.equal(client.threadSubscription('t1').followed, true, 'the retry is followed by its own answer');
  await client.close();
});

test('a legacy fallback the core refuses fails the open with that refusal: the thread is lost, not followed', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const lost: unknown[] = [];
  client.on((event) => event.type === 'subscriptionLost' && lost.push(event.error));
  const { opening, fallback } = await openToFallback(client, conn);
  conn.serverSend({
    id: fallback.id,
    error: { code: -32000, message: 'thread missing', data: { reason: 'threadNotFound' } },
  });
  const gone = (detail?: { kind?: string; reason?: string }) =>
    detail?.kind === 'rpc' && detail.reason === 'threadNotFound';
  await assert.rejects(opening, (error: { detail?: { kind?: string; reason?: string } }) => gone(error.detail));
  assert.equal(lost.length, 1);
  assert.ok(gone(lost[0] as { kind?: string; reason?: string }), 'the loss names the same refusal');
  const subscription = client.threadSubscription('t1');
  assert.deepEqual(
    [subscription.followed, subscription.snapshotPending, subscription.replayPending],
    [false, false, false]
  );
  await client.close();
});

const turn = () => new Promise((resolve) => setImmediate(resolve));
const frame = (seq: number) => ({ method: 'thread/frame', params: {}, feed: { id: 't1', epoch: 'e', seq } });
const snapshot = (seq: number) => ({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'e', seq } });
/** An attach answer naming the core subscription `sub`: the same name as the one held is a carried resume. */
const answer = (id: number, sub: string, mode: 'snapshot' | 'replay', startSeq: number, liveSeq = startSeq) => ({
  id,
  result: { subscription: { id: sub, mode, epoch: 'e', startSeq, liveSeq } },
});

/** `t1` followed on the core subscription `lane` and folded through seq 2; `folds` lists the positions folded from here. */
const atTwo = async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const opened = client.resumeThread('t1', { lastItems: 32 });
  conn.serverSend(answer(JSON.parse(await conn.nextSent()).id, 'lane', 'snapshot', 1));
  await opened;
  conn.serverSend(snapshot(0));
  conn.serverSend(frame(1));
  conn.serverSend(frame(2));
  await turn();
  const folds: Array<number | undefined> = [];
  client.store.subscribe((change) => {
    if (change.type === 'thread') folds.push(client.store.thread('t1')?.feed.seq);
  });
  return { conn, client, folds };
};

test('a resume the core carries on the same subscription neither rewinds the feed nor promises repeats: 3 before the answer, 4 after it', async () => {
  const { conn, client, folds } = await atTwo();
  const again = client.resumeThread('t1', { lastItems: 32 });
  const request = JSON.parse(await conn.nextSent());
  assert.equal(request.params.resumeFrom.seq, 2);
  conn.serverSend(frame(3));
  conn.serverSend(answer(request.id, 'lane', 'replay', 3, 4));
  await again;
  conn.serverSend(frame(4));
  await turn();
  assert.deepEqual(folds, [3, 4], 'each event folds once');
  assert.equal(client.feedPosition('t1')?.seq, 4);
  assert.equal(client.store.thread('t1')?.feed.seq, 4);
  const subscription = client.threadSubscription('t1');
  assert.deepEqual([subscription.replayPending, subscription.snapshotPending], [false, false]);
  assert.equal(conn.clientClose, undefined, 'the link stays open');
  await client.close();
});

test('a reopen ends the attach that is out as the loss of the thread: its waiter is rejected, its answer changes nothing, and the new snapshot accounts for what came between', async () => {
  const { conn, client, folds } = await atTwo();
  let old: string | undefined;
  client.resumeThread('t1', { lastItems: 32 }).then(
    () => (old = 'followed'),
    (error: { detail?: { kind?: string } }) => (old = error.detail?.kind)
  );
  const stalled = JSON.parse(await conn.nextSent());
  const lost: string[] = [];
  client.on((event) => event.type === 'subscriptionLost' && lost.push(event.threadId));

  const retry = client.reopenThread('t1', { lastItems: 32 });
  const fresh = JSON.parse(await conn.nextSent());
  assert.equal(fresh.method, 'thread/resume');
  assert.notEqual(fresh.id, stalled.id);
  assert.equal(fresh.params.resumeFrom, undefined, 'an ordinary open with no cursor');
  await turn();
  assert.equal(old, 'requestTimeout', 'the old waiter has the loss, never the new success');
  assert.deepEqual(lost, ['t1'], 'reported once');

  conn.serverSend(answer(stalled.id, 'lane', 'replay', 3, 4));
  conn.serverSend(frame(3));
  await turn();
  assert.equal(client.threadSubscription('t1').followed, false, 'the late answer does not revive the thread');
  assert.equal(conn.clientClose, undefined);

  conn.serverSend(answer(fresh.id, 'fresh', 'snapshot', 4));
  await retry;
  conn.serverSend(snapshot(3));
  conn.serverSend(frame(4));
  await turn();
  assert.deepEqual(folds, [3, 4], 'the snapshot stands for 3, and 4 folds exactly once');
  assert.equal(client.feedPosition('t1')?.seq, 4);
  assert.equal(old, 'requestTimeout');
  assert.equal(conn.clientClose, undefined);
  await client.close();
});

test('a reopen is not queued behind the fold it abandoned: the old snapshot waits on a read that is never answered, and the new one folds', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const opened = client.resumeThread('t1', { lastItems: 32 });
  conn.serverSend(answer(JSON.parse(await conn.nextSent()).id, 'lane', 'snapshot', 1));
  await opened;
  conn.serverSend({
    method: 'thread/snapshot',
    params: { text: { blob: { digest: 'd1', bytes: 4, mediaType: 'text/plain' } } },
    feed: { id: 't1', epoch: 'e', seq: 0 },
  });
  assert.equal(JSON.parse(await conn.nextSent()).method, 'blob/read', 'the fold waits on this read');

  const retry = client.reopenThread('t1', { lastItems: 32 });
  const fresh = JSON.parse(await conn.nextSent());
  assert.equal(fresh.method, 'thread/resume');
  conn.serverSend(answer(fresh.id, 'fresh', 'snapshot', 6));
  await retry;
  conn.serverSend({ method: 'thread/snapshot', params: {}, feed: { id: 't1', epoch: 'e', seq: 5 } });
  await turn();
  assert.equal(client.store.thread('t1')?.feed.seq, 5, 'the new snapshot folded');
  assert.equal(client.threadSubscription('t1').snapshotPending, false);
  await client.close();
});

test('an unsubscribe ends the wait for a snapshot that was acknowledged and will not be folded', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const opened = client.resumeThread('t1', { lastItems: 32 });
  conn.serverSend(answer(JSON.parse(await conn.nextSent()).id, 'lane', 'snapshot', 1));
  await opened;
  let settled: boolean | undefined;
  const waiting = client.whenThreadSettled('t1').then((arrived) => (settled = arrived));
  await turn();
  assert.equal(settled, undefined, 'the snapshot is owed');
  void client.unsubscribeThread('t1').catch(() => undefined);
  await waiting;
  assert.equal(settled, false, 'the wait ended without the transcript');
  assert.equal(client.threadSubscription('t1').snapshotPending, false);
  await client.close();
});

for (const [name, deadline] of [
  ['its signal', false],
  ['its deadline', true],
] as const) {
  test(`a caller whose wait ends by ${name} after the request left gives up nothing on the wire: the attach stays pending, and its snapshot and the next event fold`, async () => {
    const r = rig();
    const conn = await r.handshake();
    const client = await r.connecting;
    const leaving = new AbortController();
    const opening = client.resumeThread(
      't1',
      { lastItems: 5 },
      deadline ? { timeoutMs: 30 } : { signal: leaving.signal }
    );
    const request = JSON.parse(await conn.nextSent());
    leaving.abort();
    await assert.rejects(
      opening,
      (error: { detail?: { kind?: string; sent?: boolean } }) =>
        error.detail?.kind === 'requestTimeout' && error.detail.sent === true
    );
    await turn();
    assert.equal(client.threadSubscription('t1').snapshotPending, true, 'the request is still visibly out');
    client.resumeThread('t1', { lastItems: 5 }, { join: true }).catch(() => undefined);
    await turn();
    assert.deepEqual(conn.sent, [], 'and still the one attach of the thread');

    conn.serverSend(answer(request.id, 's1', 'snapshot', 1));
    await turn();
    const answered = client.threadSubscription('t1');
    assert.deepEqual([answered.followed, answered.snapshotPending], [true, true], 'followed, its snapshot owed');
    conn.serverSend(snapshot(0));
    conn.serverSend(frame(1));
    await turn();
    assert.equal(client.store.thread('t1')?.feed.seq, 1);
    assert.equal(client.threadSubscription('t1').snapshotPending, false);
    await client.close();
  });
}

test('an attach the core refused for backpressure and that ended meanwhile is not sent again when the retry trigger fires', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  client.resumeThread('t1', { lastItems: 5 }).catch(() => undefined);
  const refused = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: refused.id, error: { code: -32001, message: 'full', data: { reason: 'queueFull' } } });
  await turn();
  assert.deepEqual(conn.sent, [], 'it waits for a response to one of its own requests');

  const retry = client.reopenThread('t1', { lastItems: 5 });
  const fresh = JSON.parse(await conn.nextSent());
  assert.equal(fresh.method, 'thread/resume');
  // The response that would have let the refused request go again.
  conn.serverSend(answer(fresh.id, 's1', 'snapshot', 1));
  await retry;
  await turn();
  assert.deepEqual(conn.sent, [], 'the ended request does not leave again');
  await client.close();
});

test('an attach nobody waits for any more before it was written never departs', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  first.serverClose(1006);
  const leaving = new AbortController();
  const opening = client.resumeThread('t1', { lastItems: 5 }, { signal: leaving.signal });
  await turn();
  leaving.abort();
  await assert.rejects(
    opening,
    (error: { detail?: { kind?: string; sent?: boolean } }) =>
      error.detail?.kind === 'requestTimeout' && error.detail.sent === false
  );
  await turn();
  assert.equal(client.threadSubscription('t1').snapshotPending, false);
  const second = await r.handshake();
  await turn();
  assert.deepEqual(second.sent, [], 'nothing of it is written once the connection is back');
  await client.close();
});

test('a restore that was out when its thread was lost reports nothing of the open that followed', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  await follow(client, first, 't1');
  first.serverClose(1006);
  const second = await r.handshake();
  const restore = JSON.parse(await second.nextSent());
  assert.equal(restore.method, 'thread/resume');
  const states: string[] = [];
  client.store.subscribe((change) => {
    if (change.type === 'subscription' && change.feedId === 't1') states.push(change.state);
  });
  const retry = client.reopenThread('t1', { lastItems: 5 });
  const fresh = JSON.parse(await second.nextSent());
  assert.equal(client.threadSubscription('t1').restoring, false, 'the restore no longer owns the thread');
  second.serverSend(answer(fresh.id, 's2', 'snapshot', 1));
  await retry;
  second.serverSend({ id: restore.id, result: attached });
  await turn();
  assert.deepEqual(states, ['lost'], 'no `restored` of the old restore for the new open');
  assert.equal(client.threadSubscription('t1').followed, true);
  assert.equal(second.clientClose, undefined);
  await client.close();
});

test('a pending approval is held again once the core presents it on the new connection', async () => {
  const r = rig();
  const first = await r.handshake();
  const client = await r.connecting;
  const request = {
    id: 'ap1',
    method: 'item/tool/requestApproval',
    params: { threadId: 't1', requestedAt: 1, order: 1, kind: 'shell', tool: 'bash', request: {} },
  };
  first.serverSend(request);
  assert.deepEqual(
    client.pendingServerRequests().map((p) => p.id),
    ['ap1']
  );
  first.serverClose(1006);
  assert.deepEqual(client.pendingServerRequests(), [], 'a request belongs to its connection');
  await r.handshake((conn) => conn.serverSend(request));
  assert.deepEqual(
    client.pendingServerRequests().map((p) => p.id),
    ['ap1']
  );
  client.respond('ap1', { result: { approved: true } } as never);
  await client.close();
});

test('a listener that throws does not keep the others from hearing the change', async () => {
  const r = rig();
  const conn = await r.handshake();
  const client = await r.connecting;
  const heard: string[] = [];
  const log = console.error;
  console.error = () => undefined;
  try {
    client.on(() => {
      throw new Error('a presentation listener failed');
    });
    client.on((event) => heard.push(event.type));
    conn.serverSend({
      id: 'ap1',
      method: 'item/tool/requestApproval',
      params: { threadId: 't1', requestedAt: 1, order: 1, kind: 'shell', tool: 'bash', request: {} },
    });
  } finally {
    console.error = log;
  }
  assert.ok(heard.includes('serverRequest'));
  await client.close();
});

test('a transport that is accepted but never answers initialize ends the first connection at the deadline', async () => {
  const r = rig({ firstConnectDeadlineMs: 80 });
  const conn = await r.net.accept();
  await conn.nextSent();
  await assert.rejects(
    r.connecting,
    (error: { detail?: { kind?: string } }) => error.detail?.kind === 'requestTimeout'
  );
  assert.equal(conn.clientClose?.code, 1000, 'the abandoned socket is closed');
});

test('a dial slower than the deadline is waited for: only the handshake is timed', async () => {
  const r = rig({ firstConnectDeadlineMs: 80 });
  // The launcher behind the connector is still waiting for a core that says it is starting.
  const open = r.net.open.bind(r.net);
  r.net.open = async (target, sink) => {
    await later(200);
    return open(target, sink);
  };
  await r.handshake();
  const client = await r.connecting;
  assert.equal(client.status.state, 'ready');
  await client.close();
});

test('a request outlives any age while the connection is alive: a delayed installation, conversion or preparation resolves, never "outcome unknown"', async () => {
  const r = rig({ requestTimeoutMs: 20 });
  const conn = await r.handshake();
  const client = await r.connecting;
  const running = [
    client.call('config/setBuiltinToolEnabled', { name: 'localProvider', enabled: true }),
    client.call('config/installBuiltinFeature', { name: 'memory' }),
    client.call('thread/compact/start', { threadId: 't1' } as never),
  ];
  const frames = [
    JSON.parse(await conn.nextSent()),
    JSON.parse(await conn.nextSent()),
    JSON.parse(await conn.nextSent()),
  ];
  await later(120);
  for (const [i, frame] of frames.entries()) conn.serverSend({ id: frame.id, result: { done: i } });
  assert.deepEqual(await Promise.all(running), [{ done: 0 }, { done: 1 }, { done: 2 }]);
  await client.close();
});

test('a request that expired before it was sent is never sent', async () => {
  const r = rig({ requestTimeoutMs: 30 });
  const first = await r.handshake();
  const client = await r.connecting;
  first.serverClose(1006);
  const pending = client.call('thread/delete', { threadId: 't1' });
  await assert.rejects(
    pending,
    (error: { detail?: { kind?: string; sent?: boolean } }) =>
      error.detail?.kind === 'requestTimeout' && error.detail.sent === false
  );
  const second = await r.handshake();
  await later(30);
  assert.equal(second.sent.length, 0, 'nothing but the handshake was sent');
  await client.close();
});
