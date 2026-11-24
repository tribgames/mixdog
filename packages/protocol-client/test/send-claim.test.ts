// A call's `sent` option is threaded to the writer's `send(text, sent)` of that call's own request frame -- wherever the method waits before
// writing (the connection coming back, a digest) and whichever method writes -- and a call that never writes hands nothing over. Every wait
// here is on an explicit signal: the connection's status, the transport's write hook, or the call's own settle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SentClaim, TransportSink, TransportWriter } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { type MockConn, MockNetwork } from '../src/mock.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

interface Frame {
  readonly body: { id?: number; method?: string };
  readonly sent: SentClaim | undefined;
}

async function rig(limits: Record<string, unknown> = {}) {
  const net = new MockNetwork();
  const frames: Frame[] = [];
  const open = net.open.bind(net);
  net.open = async (target, sink: TransportSink): Promise<TransportWriter> => {
    const writer = await open(target, sink);
    // As a transport does: the claim of a request frame is given the completion of that frame (here, at once).
    return {
      ...writer,
      send: (text, sent) => {
        frames.push({ body: JSON.parse(text), sent });
        sent?.(Promise.resolve());
        return writer.send(text);
      },
    };
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
  const handshake = async (serverInstanceId = 'i1'): Promise<MockConn> => {
    const conn = await net.accept();
    const init = JSON.parse(await conn.nextSent());
    conn.serverSend({
      id: init.id,
      result: {
        ...options.initializeResult,
        limits: { ...options.initializeResult.limits, ...limits },
        serverInstanceId,
      },
    });
    await conn.nextSent();
    return conn;
  };
  let conn = await handshake();
  const client = await connecting;
  /** Resolves on the next status change to `state`. */
  const statusIs = (state: string): Promise<void> =>
    new Promise((resolve) => {
      const off = client.on((event) => {
        if (event.type === 'status' && event.status.state === state) {
          off();
          resolve();
        }
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
    /** The next request the client writes, unanswered. */
    next: async (): Promise<{ id: number; method: string; params: { offset?: number } }> =>
      JSON.parse(await conn.nextSent()),
    reply: (frame: unknown) => conn.serverSend(frame as never),
    statusIs,
    /** Resolves with the length of the frame log at the moment the client went `reconnecting`: what follows belongs to the next connection. */
    lose: async (): Promise<number> => {
      const down = statusIs('reconnecting');
      conn.serverClose(1006);
      await down;
      return frames.length;
    },
    /** `serverInstanceId` other than the first connection's: the core restarted meanwhile. */
    reconnect: async (serverInstanceId?: string) => {
      const up = statusIs('ready');
      conn = await handshake(serverInstanceId);
      await up;
    },
  };
}

const CALL = 'thread/list';

/** The call's frame comes after the `initialized` of the connection made after `reconnectingAt` (a log index), not after the original handshake's. */
export function writtenAfterReconnectHandshake(
  methods: readonly (string | undefined)[],
  reconnectingAt: number
): boolean {
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
  assert.ok(
    writtenAfterReconnectHandshake(methods, reconnectingAt),
    'the call is written after the new connection is ready'
  );
  const written = methods.indexOf(CALL);
  assert.ok(frames[written]?.sent, "the frame carries this call's claim");
  await answerNext();
  assert.equal(mine.got.length, 1);
});

test('the order check rejects a call written between the original handshake and the reconnect handshake', () => {
  // [original initialized, premature call, reconnect initialize/initialized]: the reconnecting status came after the first two frames.
  assert.equal(
    writtenAfterReconnectHandshake(['initialize', 'initialized', CALL, 'initialize', 'initialized'], 2),
    false
  );
  assert.equal(
    writtenAfterReconnectHandshake(['initialize', 'initialized', 'initialize', 'initialized', CALL], 2),
    true
  );
  assert.equal(writtenAfterReconnectHandshake(['initialize', 'initialized'], 2), false, 'no call at all');
});

test('thread/resume passes its claim to its own frame', async () => {
  const { client, answerNext } = await rig();
  const mine = recorder();
  const resumed = client.resumeThread('t1', { lastItems: 5 }, { sent: mine.claim });
  void resumed.catch(() => undefined);
  const frame = await answerNext({});
  assert.equal(frame.method, 'thread/resume');
  // The frame's departure reaches the caller's claim (the client observes it on the way, for the calls that join this resume).
  assert.equal(mine.got.length, 1);
});

test('a multi-chunk upload hands its claim to the last chunk, once: the upload has left when its last chunk has', async () => {
  const { client, frames, answerNext } = await rig();
  const chunk = options.initializeResult.limits.maxBlobPutChunkBytes as number;
  const mine = recorder();
  const uploaded = client.putBlob(new Uint8Array(chunk * 2 + 10), 'application/octet-stream', { sent: mine.claim });
  void uploaded.catch(() => undefined);
  await answerNext({});
  await answerNext({});
  await answerNext({});
  await uploaded;
  assert.equal(mine.got.length, 1, 'the third and last chunk carries the claim, once');
  const puts = frames.filter((f) => f.body.method === 'blob/put');
  assert.equal(puts.length, 3);
  assert.deepEqual(
    puts.map((f) => f.sent === mine.claim),
    [false, false, true]
  );
});

// Digest and base64 of a large put take real time before the first frame.
const settleIo = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 300));
type PutFrame = { id: number; method: string; params: { offset: number } };
const putsOf = (frames: Array<{ body: unknown }>): PutFrame[] =>
  frames.map((f) => f.body as PutFrame).filter((b) => b.method === 'blob/put');
const putAt = (frames: Array<{ body: unknown }>, index: number): PutFrame => {
  const put = putsOf(frames)[index];
  if (!put) throw new Error(`no chunk ${index}`);
  return put;
};

test('a multi-chunk put sends the next chunk before the first is answered, within maxUploadInFlightBytes', async () => {
  const { client, frames, reply } = await rig();
  const limits = options.initializeResult.limits;
  const chunk = limits.maxBlobPutChunkBytes as number;
  const wire = 4 * Math.ceil(chunk / 3);
  const fit = Math.floor((limits.maxUploadInFlightBytes as number) / wire);
  const total = fit + 2;
  const uploaded = client.putBlob(new Uint8Array(chunk * total), 'application/octet-stream');
  await settleIo();
  assert.equal(putsOf(frames).length, fit, 'every chunk the budget holds is out before any answer');
  assert.deepEqual(
    putsOf(frames).map((p) => p.params.offset),
    Array.from({ length: fit }, (_, i) => i * chunk),
    'in order'
  );
  reply({ id: putAt(frames, 0).id, result: {} });
  await settleIo();
  assert.equal(putsOf(frames).length, fit + 1, 'an answer frees budget for the next chunk');
  for (const put of putsOf(frames).slice(1)) reply({ id: put.id, result: {} });
  await settleIo();
  reply({ id: putAt(frames, fit + 1).id, result: {} });
  const ref = await uploaded;
  assert.equal(ref.blob.bytes, chunk * total);
  assert.equal(putsOf(frames).length, total, 'nothing is sent twice');
});

test('a core that states no in-flight budget is served one chunk at a time', async () => {
  const { client, frames, reply } = await rig({ maxUploadInFlightBytes: 0 });
  const chunk = options.initializeResult.limits.maxBlobPutChunkBytes as number;
  const uploaded = client.putBlob(new Uint8Array(chunk * 2), 'application/octet-stream');
  await settleIo();
  assert.equal(putsOf(frames).length, 1);
  reply({ id: putAt(frames, 0).id, result: {} });
  await settleIo();
  assert.equal(putsOf(frames).length, 2);
  reply({ id: putAt(frames, 1).id, result: {} });
  await uploaded;
});

test('a chunk failing mid-way fails the put once with its error, and no chunk is sent after it', async () => {
  const { client, frames, reply } = await rig();
  const chunk = options.initializeResult.limits.maxBlobPutChunkBytes as number;
  let progress = 0;
  const uploaded = client.putBlob(new Uint8Array(chunk * 3), 'application/octet-stream', {
    onChunkAccepted: () => void (progress += 1),
  });
  const outcome = uploaded.then(
    () => 'resolved',
    (error: Error) => error.message
  );
  await settleIo();
  const [first, second, third] = putsOf(frames) as [PutFrame, PutFrame, PutFrame];
  reply({ id: first.id, result: {} });
  reply({
    id: second.id,
    error: { code: -32603, message: 'disk full', data: { reason: 'internal', incidentId: 'x' } },
  });
  reply({ id: third.id, result: {} });
  assert.match(await outcome, /disk full/);
  assert.equal(putsOf(frames).length, 3, 'no chunk is uploaded again or after the failure');
  assert.equal(progress, 2, 'the answered chunks were reported once each');
});

test('chunks the core refuses as out of order resume from the bytes it holds, nothing already held is sent again', async () => {
  const { client, frames, reply } = await rig();
  const chunk = options.initializeResult.limits.maxBlobPutChunkBytes as number;
  const uploaded = client.putBlob(new Uint8Array(chunk * 3), 'application/octet-stream');
  await settleIo();
  const [first, second, third] = putsOf(frames) as [PutFrame, PutFrame, PutFrame];
  const outOfOrder = {
    code: -32602,
    message: 'invalid params',
    data: { reason: 'invalidParams', path: 'offset', expected: 'the next byte after those already received' },
  };
  reply({ id: first.id, result: {} });
  reply({ id: second.id, error: outOfOrder });
  reply({ id: third.id, error: outOfOrder });
  await settleIo();
  const resumed = putsOf(frames);
  assert.equal(resumed.length, 4);
  assert.equal(putAt(frames, 3).params.offset, chunk, 'it resumes after the acknowledged chunk');
  reply({ id: putAt(frames, 3).id, result: {} });
  await settleIo();
  assert.equal(putAt(frames, 4).params.offset, chunk * 2);
  reply({ id: putAt(frames, 4).id, result: {} });
  await uploaded;
  assert.equal(putsOf(frames).length, 5);
});

// blob.rs `already_stored`: a continuation chunk of a digest the core holds no staging for.
const DROPPED = {
  code: -32602,
  message: 'invalid params',
  data: { reason: 'invalidParams', path: 'offset', expected: '0: no upload of this blob is in progress' },
};

/** A three-chunk upload served one chunk at a time; `answer` takes its next chunk, which must be at `offset`, or fails on the put's outcome. */
async function droppedUpload() {
  const harness = await rig({ maxUploadInFlightBytes: 0 });
  const chunk = options.initializeResult.limits.maxBlobPutChunkBytes as number;
  const outcome = harness.client.putBlob(new Uint8Array(chunk * 3), 'application/octet-stream').then(
    () => 'resolved',
    (error: unknown) => error
  );
  const step = async () => {
    const put = await Promise.race([harness.next(), outcome]);
    assert.equal(typeof put === 'object' && put !== null && 'method' in put ? put.method : put, 'blob/put');
    return put as { id: number; params: { offset?: number } };
  };
  const answer = async (offset: number, error?: unknown) => {
    const put = await step();
    assert.equal(put.params.offset, offset);
    harness.reply(error === undefined ? { id: put.id, result: {} } : { id: put.id, error });
  };
  return { ...harness, chunk, outcome, step, answer };
}

test('an upload whose core restarted part-way starts again from the first byte on the new core', async () => {
  const { chunk, outcome, step, answer, reply, lose, reconnect } = await droppedUpload();
  await answer(0);
  // Refused before it ran, the chunk waits for its retry; the core restarts meanwhile and the chunk goes to the new one.
  const waiting = await step();
  assert.equal(waiting.params.offset, chunk);
  reply({ id: waiting.id, error: { code: -32001, message: 'busy', data: { reason: 'inflightLimit', class: 'C1' } } });
  await lose();
  await reconnect('i2');
  await answer(chunk, DROPPED);
  await answer(chunk, DROPPED);
  await answer(0);
  await answer(chunk);
  await answer(chunk * 2);
  assert.equal(await outcome, 'resolved');
});

test('an upload the core that acknowledged its bytes dropped fails once with its refusal, nothing sent again from the first byte', async () => {
  const { chunk, outcome, next, answer } = await droppedUpload();
  await answer(0);
  await answer(chunk, DROPPED);
  // From the bytes acknowledged, once: the same core no longer holds them either.
  await answer(chunk, DROPPED);
  const settled = await Promise.race([next(), outcome]);
  const detail = (settled as { detail?: { reason?: string; data?: { path?: string; expected?: string } } }).detail;
  assert.equal(detail?.reason, 'invalidParams', 'the put ends with the core refusal, not another chunk');
  assert.equal(detail?.data?.path, 'offset');
  assert.equal(detail?.data?.expected, DROPPED.data.expected);
});

test("a call that never writes hands nothing over, and the next call's frame is claimed by that call alone", async () => {
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
