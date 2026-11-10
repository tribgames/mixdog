// A call's `sent` option is threaded to the writer's `send(text, sent)` of that call's own request frame -- wherever the method waits before
// writing (the connection coming back, a digest) and whichever method writes -- and a call that never writes hands nothing over. Every wait
// here is on an explicit signal: the connection's status, the transport's write hook, or the call's own settle.
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
    // As a transport does: the claim of a request frame is given the completion of that frame (here, at once).
    return { ...writer, send: (text, sent) => (frames.push({ body: JSON.parse(text), sent }), sent?.(Promise.resolve()), writer.send(text)) };
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
  /** Resolves on the next status change to `state`. */
  const statusIs = (state: string): Promise<void> =>
    new Promise((resolve) => {
      const off = client.on((event) => {
        if (event.type === 'status' && event.status.state === state) (off(), resolve());
      });
    });
  const answerNext = async (result: unknown = {}): Promise<{ id: number; method: string }> => {
    const frame = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: frame.id, result });
    return frame;
  };
  return {
    client,
    frames,
    answerNext,
    statusIs,
    /** Resolves with the length of the frame log at the moment the client went `reconnecting`: what follows belongs to the next connection. */
    lose: async (): Promise<number> => {
      const down = statusIs('reconnecting');
      conn.serverClose(1006);
      await down;
      return frames.length;
    },
    reconnect: async () => {
      const up = statusIs('ready');
      conn = await handshake();
      await up;
    },
  };
}

const CALL = 'thread/list';

/** The call's frame comes after the `initialized` of the connection made after `reconnectingAt` (a log index), not after the original handshake's. */
export function writtenAfterReconnectHandshake(methods: readonly (string | undefined)[], reconnectingAt: number): boolean {
  const written = methods.indexOf(CALL);
  if (written < 0) return false;
  const initialized = methods.lastIndexOf('initialized', written);
  return initialized >= reconnectingAt;
}

/** A claim that records what it was given; the promise it received is wrapped so awaiting the record does not wait for the frame. */
const recorder = () => {
  const got: Array<Promise<void>> = [];
  return { got, claim: ((sent: Promise<void>) => void got.push(sent)) as SentClaim };
};

test('a call asked while the connection is down writes nothing then, and hands its frame to its claim once the connection is back', async () => {
  const { client, frames, lose, reconnect, answerNext } = await rig();
  const reconnectingAt = await lose();
  const mine = recorder();
  const call = client.call(CALL, {} as never, { sent: mine.claim });
  void call.catch(() => undefined);
  await reconnect();
  const methods = frames.map((frame) => frame.body.method);
  // `initialized` is the last frame of the new handshake: the call's frame, if it had been written while down, would precede it.
  assert.ok(writtenAfterReconnectHandshake(methods, reconnectingAt), 'the call is written after the new connection is ready');
  const written = methods.indexOf(CALL);
  assert.ok(frames[written]?.sent, 'the frame carries this call\'s claim');
  await answerNext();
  assert.equal(mine.got.length, 1);
});

test('the order check rejects a call written between the original handshake and the reconnect handshake', () => {
  // [original initialized, premature call, reconnect initialize/initialized]: the reconnecting status came after the first two frames.
  assert.equal(writtenAfterReconnectHandshake(['initialize', 'initialized', CALL, 'initialize', 'initialized'], 2), false);
  assert.equal(writtenAfterReconnectHandshake(['initialize', 'initialized', 'initialize', 'initialized', CALL], 2), true);
  assert.equal(writtenAfterReconnectHandshake(['initialize', 'initialized'], 2), false, 'no call at all');
});

test('thread/resume passes its claim to its own frame', async () => {
  const { client, frames, answerNext } = await rig();
  const mine = recorder();
  const resumed = client.resumeThread('t1', { lastItems: 5 }, { sent: mine.claim });
  void resumed.catch(() => undefined);
  const frame = await answerNext({});
  assert.equal(frame.method, 'thread/resume');
  assert.equal(frames.find((f) => f.body.method === 'thread/resume')?.sent, mine.claim);
  assert.equal(mine.got.length, 1);
});

test('a multi-chunk upload hands its claim to the last chunk, once: the upload has left when its last chunk has', async () => {
  const { client, frames, answerNext } = await rig();
  const chunk = options.initializeResult.limits.maxBlobPutChunkBytes as number;
  const mine = recorder();
  const uploaded = client.putBlob(new Uint8Array(chunk * 2 + 10), 'application/octet-stream', { sent: mine.claim });
  void uploaded.catch(() => undefined);
  await answerNext({});
  assert.equal(mine.got.length, 0, 'the first chunk is not the end of the upload');
  await answerNext({});
  assert.equal(mine.got.length, 0, 'nor is the second');
  await answerNext({});
  assert.equal(mine.got.length, 1, 'the third and last chunk carries the claim');
  const puts = frames.filter((f) => f.body.method === 'blob/put');
  assert.equal(puts.length, 3);
  assert.deepEqual(puts.map((f) => f.sent === mine.claim), [false, false, true]);
});

test('a call that never writes hands nothing over, and the next call\'s frame is claimed by that call alone', async () => {
  const { client, frames, answerNext } = await rig();
  const refused = recorder();
  await assert.rejects(client.call('no/such/method' as never, {} as never, { sent: refused.claim }));
  const second = recorder();
  void client.call(CALL, {} as never, { sent: second.claim }).catch(() => undefined);
  const frame = await answerNext();
  assert.equal(frame.method, CALL);
  assert.equal(frames.find((f) => f.body.method === CALL)?.sent, second.claim);
  assert.equal(refused.got.length, 0);
  assert.equal(second.got.length, 1);
});