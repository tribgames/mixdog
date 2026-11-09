// A call's `sent` option is threaded to the writer's `send(text, sent)` of that call's own request frame -- wherever the method waits before
// writing (the connection coming back, a digest) and whichever method writes -- and a call that never writes hands nothing over.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SentClaim, TransportSink, TransportWriter } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockConn, MockNetwork } from '../src/mock.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

interface Frame {
  readonly body: { id?: number; method?: string };
  readonly sent: SentClaim | undefined;
}

async function rig() {
  const net = new MockNetwork();
  const frames: Frame[] = [];
  const open = net.open.bind(net);
  net.open = async (target, sink: TransportSink): Promise<TransportWriter> => {
    const writer = await open(target, sink);
    return { ...writer, send: (text, sent) => (frames.push({ body: JSON.parse(text), sent }), writer.send(text)) };
  };
  const connecting = connect({
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
    const init = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } });
    await conn.nextSent();
    return conn;
  };
  let conn = await handshake();
  const client = await connecting;
  const answerNext = async (result: unknown = {}): Promise<number> => {
    const frame = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: frame.id, result });
    return frame.id;
  };
  const lose = async (): Promise<void> => {
    conn.serverClose(1006);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    frames.length = 0;
  };
  return { client, frames, answerNext, lose, reconnect: async () => (conn = await handshake()) };
}

const CALL = 'thread/list';

test('a call asked while the connection is down hands its own frame to its claim when the connection is back', async () => {
  const { client, frames, lose, reconnect, answerNext } = await rig();
  await lose();
  const claimed: Array<Promise<void>> = [];
  const call = client.call(CALL, {}, { sent: (promise) => claimed.push(promise) });
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 0, 'nothing is written while the connection is down');
  await reconnect();
  void call.catch(() => undefined);
  await answerNext();
  const mine = frames.find((frame) => frame.body.method === CALL);
  assert.ok(mine?.sent, 'the frame carries this call\'s claim');
  mine.sent(Promise.resolve());
  assert.equal(claimed.length, 1);
});

test('thread/resume and the blob upload (which digests first) pass their claim to their own frame', async () => {
  const { client, frames, answerNext } = await rig();
  let resumed = 0;
  void client.resumeThread('t1', { lastItems: 5 }, { sent: () => (resumed += 1) }).catch(() => undefined);
  await answerNext({});
  const resume = frames.find((frame) => frame.body.method === 'thread/resume');
  assert.ok(resume?.sent, 'thread/resume carries the claim');
  resume.sent(Promise.resolve());
  assert.equal(resumed, 1);
  let uploaded = 0;
  void client.putBlob(new Uint8Array([1, 2, 3]), 'application/octet-stream', { sent: () => (uploaded += 1) }).catch(() => undefined);
  await answerNext({});
  const put = frames.find((frame) => frame.body.method === 'blob/put');
  assert.ok(put?.sent, 'blob/put carries the claim');
  put.sent(Promise.resolve());
  assert.equal(uploaded, 1);
});

test('a call that never writes hands nothing over, and the next call\'s frame is claimed by that call alone', async () => {
  const { client, frames, answerNext } = await rig();
  let refused = 0;
  await assert.rejects(client.call('no/such/method' as never, {} as never, { sent: () => (refused += 1) }));
  let second = 0;
  void client.call(CALL, {}, { sent: () => (second += 1) }).catch(() => undefined);
  await answerNext();
  const mine = frames.find((frame) => frame.body.method === CALL);
  assert.ok(mine?.sent);
  mine.sent(Promise.resolve());
  assert.equal(refused, 0);
  assert.equal(second, 1);
});