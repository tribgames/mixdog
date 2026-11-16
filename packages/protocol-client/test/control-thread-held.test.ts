// A control thread the client started (`thread/start` of `kind: "control"`) is the client's to keep: the reply subscribed this
// connection to it, so it is resumed after every reconnect like a followed thread, and no request names it before that resume is
// answered. Run against a scripted peer, with the real client.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { MockConn, MockNetwork } from '../src/mock.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const SUB = { subscription: { epoch: 'e1', startSeq: 1 } };
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const parse = async (conn: MockConn) => JSON.parse(await conn.nextSent());

async function opened() {
  const net = new MockNetwork();
  const open = () =>
    connect({
      target: { id: 'local' },
      connector: net,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      clock: { sleep: () => Promise.resolve() },
      random: () => options.jitterUnit,
      ladder: options.ladder,
    });
  const handshake = async (): Promise<MockConn> => {
    const conn = await net.accept();
    const init = await parse(conn);
    conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } });
    await conn.nextSent();
    return conn;
  };
  const connecting = open();
  let conn = await handshake();
  const client = await connecting;
  return { client, net, open, handshake, conn: () => conn, redial: async () => ((conn = await handshake()), conn) , first: conn };
}

async function started(rig: Awaited<ReturnType<typeof opened>>, id: string) {
  const pending = rig.client.call('thread/start', { kind: 'control' });
  const frame = await parse(rig.conn());
  assert.equal(frame.method, 'thread/start');
  rig.conn().serverSend({ id: frame.id, result: { thread: { id }, ...SUB } });
  await pending;
}

const resize = (id: string) => ({ threadId: id, images: [] }) as never;
const heldOf = (client: object, id: string): boolean => (client as { threadSubscription(id: string): { held: boolean } }).threadSubscription(id).held;

test('a control thread is resumed after a redial, and a request naming it leaves only after that resume is answered', async () => {
  const rig = await opened();
  await started(rig, 'ctl-1');
  assert.equal(heldOf(rig.client, 'ctl-1'), true);
  rig.conn().serverClose(1006);
  const second = await rig.redial();
  const call = rig.client.call('thread/resizeImage', resize('ctl-1'));
  const resume = await parse(second);
  assert.deepEqual([resume.method, resume.params.threadId, resume.params.window], ['thread/resume', 'ctl-1', { none: true }]);
  await tick();
  assert.deepEqual(second.sent, [], 'nothing names the thread while its resume is unanswered');
  second.serverSend({ id: resume.id, result: { thread: { id: 'ctl-1' }, ...SUB } });
  const sent = await parse(second);
  assert.deepEqual([sent.method, sent.params.threadId], ['thread/resizeImage', 'ctl-1']);
  second.serverSend({ id: sent.id, result: {} });
  await call;
  await rig.client.close();
});

test('a resize refused as queueFull and then cut off is sent again on the new socket only after the resume, once per socket', async () => {
  const rig = await opened();
  await started(rig, 'ctl-1');
  const call = rig.client.call('thread/resizeImage', resize('ctl-1'));
  const first = rig.conn();
  const sent = await parse(first);
  first.serverSend({ id: sent.id, error: { code: -32001, message: 'full', data: { reason: 'queueFull' } } });
  first.serverClose(1006);
  const second = await rig.redial();
  const resume = await parse(second);
  assert.equal(resume.method, 'thread/resume');
  second.serverSend({ id: resume.id, result: { thread: { id: 'ctl-1' }, ...SUB } });
  const again = await parse(second);
  assert.deepEqual([again.method, again.params.threadId, again.params.opId], ['thread/resizeImage', 'ctl-1', sent.params.opId]);
  second.serverSend({ id: again.id, result: {} });
  await call;
  assert.deepEqual(first.sent, [], 'the first socket carried it once');
  await rig.client.close();
});

test('a thread/start refused as queueFull and then cut off is retried and holds exactly one control thread', async () => {
  const rig = await opened();
  const pending = rig.client.call('thread/start', { kind: 'control' });
  const first = rig.conn();
  const frame = await parse(first);
  first.serverSend({ id: frame.id, error: { code: -32001, message: 'full', data: { reason: 'queueFull' } } });
  first.serverClose(1006);
  const second = await rig.redial();
  const retried = await parse(second);
  assert.equal(retried.method, 'thread/start');
  second.serverSend({ id: retried.id, result: { thread: { id: 'ctl-2' }, ...SUB } });
  await pending;
  second.serverClose(1006);
  const third = await rig.redial();
  const resume = await parse(third);
  assert.deepEqual([resume.method, resume.params.threadId], ['thread/resume', 'ctl-2']);
  third.serverSend({ id: resume.id, result: { thread: { id: 'ctl-2' }, ...SUB } });
  await tick();
  assert.deepEqual(third.sent, [], 'one control thread, restored once');
  await rig.client.close();
});

// Ownership is settled before dispatch: a thread the core refuses to resume is no longer held, and a request that waited for that
// resume is not sent naming it (the caller gets the core's refusal; a lane asks the client for a valid thread first).
test('a control thread the core refuses to resume is not held, and a request that waited for it is not sent', async () => {
  const rig = await opened();
  await started(rig, 'ctl-1');
  rig.conn().serverClose(1006);
  const second = await rig.redial();
  const call = rig.client.call('thread/resizeImage', resize('ctl-1'));
  const settled = (rig.client as unknown as { whenHeldSettled(id: string): Promise<void> }).whenHeldSettled('ctl-1');
  const resume = await parse(second);
  second.serverSend({ id: resume.id, error: { code: -32600, message: 'threadNotFound', data: { reason: 'threadNotFound' } } });
  await assert.rejects(call, (error: { detail?: { data?: { reason?: string } } }) => error.detail?.data?.reason === 'threadNotFound');
  await settled;
  assert.equal(heldOf(rig.client, 'ctl-1'), false);
  assert.deepEqual(second.sent, [], 'nothing naming it was written');
  await rig.client.close();
});

// A start confirmed by `op/status` (its reply was lost with the socket) is held the same way as one answered directly: the new
// socket is subscribed to it before the caller has it.
test('a thread/start confirmed through reconciliation is resumed on the new socket before the caller has it', async () => {
  const rig = await opened();
  const pending = rig.client.call('thread/start', { kind: 'control' });
  const first = rig.conn();
  await parse(first);
  first.serverClose(1006);
  const second = await rig.redial();
  const status = await parse(second);
  assert.equal(status.method, 'op/status');
  second.serverSend({ id: status.id, result: { ops: [{ opId: status.params.opIds[0], state: 'applied', result: { thread: { id: 'ctl-1' } } }] } });
  const resume = await parse(second);
  assert.deepEqual([resume.method, resume.params.threadId, resume.params.window], ['thread/resume', 'ctl-1', { none: true }]);
  let had = false;
  void pending.then(() => (had = true));
  await tick();
  assert.equal(had, false, 'not handed out before the subscription');
  second.serverSend({ id: resume.id, result: { thread: { id: 'ctl-1' }, ...SUB } });
  assert.deepEqual(((await pending) as { thread: { id: string } }).thread.id, 'ctl-1');
  assert.equal(heldOf(rig.client, 'ctl-1'), true);
  await rig.client.close();
});
test('another client does not hold it; a dropped hold (unsubscribed, or the client closed) lets a waiting request go', async () => {
  const rig = await opened();
  await started(rig, 'ctl-1');
  const other = await (async () => {
    const connecting = rig.open();
    const conn = await rig.handshake();
    return { client: await connecting, conn };
  })();
  assert.equal(heldOf(other.client, 'ctl-1'), false);
  const done = rig.client.unsubscribeThread('ctl-1');
  const frame = await parse(rig.conn());
  assert.equal(frame.method, 'thread/unsubscribe');
  rig.conn().serverSend({ id: frame.id, result: {} });
  await done;
  assert.equal(heldOf(rig.client, 'ctl-1'), false);
  rig.conn().serverClose(1006);
  const second = await rig.redial();
  await tick();
  assert.deepEqual(second.sent, []);
  await Promise.all([rig.client.close(), other.client.close()]);
});

// A resume the core never answers does not block its waiters for good: they end with the hold (dropped) or the client (closed); the
// resume itself is a request like any other and ends with its answer or the connection.
test('what waits for an unanswered resume ends when the hold is dropped or the client closes', async () => {
  const rig = await opened();
  await started(rig, 'ctl-1');
  await started(rig, 'ctl-2');
  rig.conn().serverClose(1006);
  const second = await rig.redial();
  const settles = (id: string) => (rig.client as unknown as { whenHeldSettled(id: string): Promise<void> }).whenHeldSettled(id);
  const dropped = settles('ctl-1');
  const closed = settles('ctl-2');
  const frames = [await parse(second), await parse(second)];
  assert.deepEqual(frames.map((f) => f.method), ['thread/resume', 'thread/resume']);
  void rig.client.unsubscribeThread('ctl-1').catch(() => undefined);
  await dropped;
  await rig.client.close();
  await assert.rejects(closed);
});