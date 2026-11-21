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
