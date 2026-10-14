import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  MODEL_PROXY_OPERATIONS,
  ModelProxyChannel,
  decodeModelProxyWire,
  encodeModelProxyWire,
  getModelProxyChannel,
  installModelProxyChannel,
  modelProxyErrorToWire,
} from './model-proxy-channel.mjs';
import { ModelProxyBridgeChannel, createModelProxyBridgeServer } from './model-proxy-bridge.mjs';
import {
  ModelProxyProvider,
  _resetModelProxyProviderConfigForTest,
  loadModelProxyProviderConfig,
} from './model-proxy-provider.mjs';
import { getProvider, initProviders } from './registry.mjs';
import { closeUsageLedgers } from '../../../shared/llm/usage-ledger.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function useEnv(t, values) {
  const prior = {};
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** The desktop client, exactly as model-proxy.test.mjs fakes it. */
function attachPc(channel, onRequest, snapshots = []) {
  const handled = new Set();
  return channel.attachPublisher((snapshot) => {
    snapshots.push(snapshot);
    for (const request of snapshot.requests) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      queueMicrotask(() => onRequest(request));
    }
  });
}

const op = (channel, name, ...args) => channel.handleOperation(MODEL_PROXY_OPERATIONS[name], args);

async function startBridge(t, { channel = new ModelProxyChannel(), ...options } = {}) {
  const logs = [];
  const work = [];
  const server = createModelProxyBridgeServer({
    channel,
    log: (line) => logs.push(line),
    trackWork: (active) => work.push(active),
    ...options,
  });
  const endpoint = await server.start();
  t.after(() => server.close('test end'));
  return { server, endpoint, channel, logs, work };
}

function bridgeClient(t, endpoint, options = {}) {
  const client = new ModelProxyBridgeChannel({ ...endpoint, ...options });
  t.after(() => client.dispose());
  return client;
}

/** A hand-driven bridge client for protocol violations. */
async function rawClient(t, port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const frames = [];
  const listeners = new Set();
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (text) => {
    buffer += text;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      frames.push(decodeModelProxyWire(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
    for (const listener of [...listeners]) listener();
  });
  socket.on('error', () => {});
  const closed = new Promise((resolve) => socket.once('close', resolve));
  return {
    socket,
    frames,
    closed,
    send: (frame) => socket.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`),
    next(predicate, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = frames.find(predicate);
          if (!found) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`frame not received; got ${JSON.stringify(frames)}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
    },
  };
}

async function authenticated(t, endpoint) {
  const raw = await rawClient(t, endpoint.port);
  raw.send({ type: 'hello', v: 1, token: endpoint.token });
  await raw.next((frame) => frame.type === 'state');
  return raw;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

test('a bridged send streams every callback in order, relays bytes and keeps the full send contract', async (t) => {
  const { endpoint, channel, logs } = await startBridge(t);
  let call = null;
  let replies = null;
  t.after(
    attachPc(channel, async ({ id, provider, method, model }) => {
      assert.deepEqual({ provider, method, model }, { provider: 'anthropic-oauth', method: 'send', model: 'claude-test' });
      call = decodeModelProxyWire(op(channel, 'claim', id).payload);
      const reply = await op(
        channel,
        'event',
        id,
        encodeModelProxyWire([
          { name: 'onStageChange', args: ['streaming'] },
          { name: 'onTextDelta', args: ['Hel'] },
          { name: 'onTextDelta', args: ['lo'] },
          { name: 'onTextReset', args: [{ chars: 5, bytes: Buffer.from([9]) }] },
        ])
      );
      assert.equal(reply.cancelled, false);
      replies = decodeModelProxyWire(reply.results);
      op(
        channel,
        'resolve',
        id,
        true,
        encodeModelProxyWire({ content: 'Hello', blob: Buffer.from([7, 8]), usage: { inputTokens: 3, outputTokens: 2 } }),
        null
      );
    })
  );
  const client = bridgeClient(t, endpoint);
  assert.equal(await client.whenConnected(2_000), true);
  const provider = new ModelProxyProvider('anthropic-oauth', {}, client);
  const seen = [];
  const result = await provider.send(
    [{ role: 'user', content: 'hi', bytes: Buffer.from([1, 2, 3]) }],
    'claude-test',
    [{ name: 'read', inputSchema: { type: 'object' } }],
    {
      sessionId: 'bridge-session',
      effort: 'high',
      _stallRetryBudget: { allowStallRetry() {} },
      sleepFn: () => {},
      onStageChange: (stage) => {
        seen.push(['stage', stage]);
      },
      onTextDelta: async (text) => {
        await delay(5);
        seen.push(['text', text]);
      },
      onTextReset: ({ chars, bytes }) => {
        seen.push(['reset', chars, [...bytes]]);
        return true;
      },
    }
  );
  assert.equal(result.content, 'Hello');
  assert.ok(Buffer.isBuffer(result.blob));
  assert.deepEqual([...result.blob], [7, 8]);
  assert.deepEqual(seen, [
    ['stage', 'streaming'],
    ['text', 'Hel'],
    ['text', 'lo'],
    ['reset', 5, [9]],
  ]);
  // The PC receives each callback's own return value.
  assert.deepEqual(
    replies.map((reply) => reply.value),
    [null, null, null, true]
  );
  assert.deepEqual(call.options, { sessionId: 'bridge-session', effort: 'high' });
  assert.deepEqual(call.callbacks, ['onStageChange', 'onTextDelta', 'onTextReset']);
  assert.ok(Buffer.isBuffer(call.messages[0].bytes));
  assert.deepEqual([...call.messages[0].bytes], [1, 2, 3]);
  assert.deepEqual(call.tools, [{ name: 'read', inputSchema: { type: 'object' } }]);
  assert.equal(call.toolsFinalized, false);
  assert.equal(call.nativePrefixCount, 0);

  // Finalized tools and the native prefix count reach the PC unchanged.
  let finalized = null;
  t.after(
    attachPc(channel, ({ id }) => {
      finalized = decodeModelProxyWire(op(channel, 'claim', id).payload);
      op(channel, 'resolve', id, true, encodeModelProxyWire({ content: 'ok' }), null);
    })
  );
  await client.request({
    provider: 'openai',
    method: 'send',
    model: 'gpt-test',
    messages: [],
    tools: [{ type: 'web_search' }, { name: 'shell' }],
    toolsFinalized: true,
    nativePrefixCount: 1,
    options: { effort: 'low' },
  });
  assert.equal(finalized.toolsFinalized, true);
  assert.equal(finalized.nativePrefixCount, 1);
  assert.deepEqual(finalized.tools, [{ type: 'web_search' }, { name: 'shell' }]);
  assert.deepEqual(finalized.options, { effort: 'low' });
  assert.deepEqual(finalized.callbacks, []);

  // Logs carry identifiers only.
  assert.ok(logs.some((line) => /model-proxy bridge send id=r1 provider=anthropic-oauth model=claude-test \d+ms$/.test(line)));
  assert.ok(logs.every((line) => !line.includes(endpoint.token) && !line.includes('Hello') && !line.includes('hi')));
});

test('a thrown callback error reaches the PC and PC errors keep every property', async (t) => {
  const { endpoint, channel, logs } = await startBridge(t);
  let replies = null;
  t.after(
    attachPc(channel, async ({ id }) => {
      op(channel, 'claim', id);
      const reply = await op(channel, 'event', id, encodeModelProxyWire([{ name: 'onTextReset', args: [{ chars: 1 }] }]));
      replies = decodeModelProxyWire(reply.results);
      const error = Object.assign(new Error('stream stalled'), {
        name: 'StreamStalledError',
        status: 529,
        code: 'STREAM_STALLED',
        retryAfterMs: 1500,
        partialContent: 'par',
        liveTextEmitted: true,
        partialUsage: { inputTokens: 3, outputTokens: 1 },
      });
      op(channel, 'resolve', id, false, null, encodeModelProxyWire(modelProxyErrorToWire(error)));
    })
  );
  const client = bridgeClient(t, endpoint);
  const provider = new ModelProxyProvider('openai', {}, client);
  const error = await provider
    .send([], 'gpt-test', undefined, {
      onTextReset: () => {
        throw Object.assign(new Error('reset refused'), { code: 'RESET_REFUSED', status: 409 });
      },
    })
    .then(
      () => null,
      (failure) => failure
    );
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error.message, 'reset refused');
  assert.equal(replies[0].error.props.code, 'RESET_REFUSED');
  assert.equal(replies[0].error.props.status, 409);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'StreamStalledError');
  assert.equal(error.message, 'stream stalled');
  assert.equal(error.status, 529);
  assert.equal(error.code, 'STREAM_STALLED');
  assert.equal(error.retryAfterMs, 1500);
  assert.equal(error.partialContent, 'par');
  assert.equal(error.liveTextEmitted, true);
  assert.deepEqual(error.partialUsage, { inputTokens: 3, outputTokens: 1 });
  assert.ok(logs.some((line) => line.endsWith('error=STREAM_STALLED')));
});

test('provider config relays through the bridge, cached per generation; a state change invalidates it unasked', async (t) => {
  _resetModelProxyProviderConfigForTest();
  t.after(() => _resetModelProxyProviderConfigForTest());
  const { endpoint, channel } = await startBridge(t);
  const methods = [];
  const pc = (id) => {
    const call = decodeModelProxyWire(op(channel, 'claim', id).payload);
    methods.push(call.method);
    op(
      channel,
      'resolve',
      id,
      true,
      encodeModelProxyWire({
        ready: true,
        providers: { openai: { enabled: true, apiKey: 'must-not-arrive', modelProxy: { nativePdf: true } } },
      }),
      null
    );
  };
  let detach = attachPc(channel, ({ id }) => pc(id));
  t.after(() => detach());
  const client = bridgeClient(t, endpoint);
  assert.equal(client.connected, false, 'lazy: nothing connects before it is needed');
  assert.equal(await client.whenConnected(2_000), true);
  const config = await loadModelProxyProviderConfig({ channel: client, waitMs: 3_000 });
  assert.deepEqual(config, { openai: { enabled: true, modelProxy: { nativePdf: true } } });
  const generation = client.generation;
  assert.ok(generation >= 1);
  await loadModelProxyProviderConfig({ channel: client, waitMs: 3_000 });
  assert.deepEqual(methods, ['providerConfig'], 'cached within one generation');

  // The PC leaves and another attaches: pushed state frames, no request.
  detach();
  assert.ok(await waitFor(() => client.connected === false));
  assert.ok(client.generation > generation);
  const absentGeneration = client.generation;
  detach = attachPc(channel, ({ id }) => pc(id));
  assert.ok(await waitFor(() => client.connected === true));
  assert.ok(client.generation > absentGeneration);
  assert.deepEqual(methods, ['providerConfig']);
  await loadModelProxyProviderConfig({ channel: client, waitMs: 3_000 });
  assert.deepEqual(methods, ['providerConfig', 'providerConfig'], 'a new generation asks again');
});

test('without a usable PC client a bridged call fails with MODEL_PROXY_UNAVAILABLE', async (t) => {
  const { endpoint } = await startBridge(t);
  const client = bridgeClient(t, endpoint);
  const startedAt = Date.now();
  assert.equal(await client.whenConnected(300), false);
  await assert.rejects(client.request({ provider: 'openai', method: 'isAvailable' }), {
    code: 'MODEL_PROXY_UNAVAILABLE',
  });
  assert.ok(Date.now() - startedAt < 2_000);

  // No daemon at all: whenConnected times out, a call fails unavailable.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const orphan = bridgeClient(t, { port, token: endpoint.token });
  assert.equal(await orphan.whenConnected(300), false);
  await assert.rejects(orphan.request({ provider: 'openai', method: 'isAvailable' }), {
    code: 'MODEL_PROXY_UNAVAILABLE',
  });
});

test('a child abort cancels the PC-side call; a closed bridge socket aborts every call it carried', async (t) => {
  const { endpoint, channel, server, work } = await startBridge(t);
  const snapshots = [];
  const claimed = [];
  const claimedSignal = { resolve: null };
  t.after(
    attachPc(
      channel,
      ({ id }) => {
        op(channel, 'claim', id);
        claimed.push(id);
        claimedSignal.resolve?.();
      },
      snapshots
    )
  );
  const nextClaim = () =>
    new Promise((resolve) => {
      claimedSignal.resolve = resolve;
    });
  const client = bridgeClient(t, endpoint);
  const deltas = [];
  const controller = new AbortController();
  let claim = nextClaim();
  const sending = new ModelProxyProvider('openai', {}, client).send([], 'gpt-test', undefined, {
    signal: controller.signal,
    onTextDelta: (text) => deltas.push(text),
  });
  await claim;
  assert.equal(server.activeCount, 1);
  controller.abort(new Error('user stop'));
  await assert.rejects(sending, /user stop/);
  assert.ok(await waitFor(() => snapshots.at(-1)?.cancelled.includes(claimed[0])), 'the PC sees the cancel');
  const late = await op(channel, 'event', claimed[0], encodeModelProxyWire([{ name: 'onTextDelta', args: ['late'] }]));
  assert.equal(late.cancelled, true);
  assert.deepEqual(deltas, []);
  assert.ok(await waitFor(() => server.activeCount === 0));

  // Aborted before the bridge even connected: nothing is ever sent.
  const early = new AbortController();
  early.abort();
  const fresh = bridgeClient(t, endpoint);
  await assert.rejects(fresh.request({ provider: 'openai', method: 'send' }, { signal: early.signal }), {
    name: 'AbortError',
  });
  // Aborted during the handshake: rejected, never sent.
  const handshake = new AbortController();
  const during = fresh.request({ provider: 'openai', method: 'send' }, { signal: handshake.signal });
  handshake.abort();
  await assert.rejects(during, { name: 'AbortError' });
  await delay(50);
  assert.equal(claimed.length, 1, 'no call reached the PC');

  // The bridge client goes away mid-call.
  claim = nextClaim();
  const running = client.request({ provider: 'openai', method: 'send', model: 'm' });
  await claim;
  client.dispose();
  await assert.rejects(running, { code: 'MODEL_PROXY_UNAVAILABLE' });
  assert.ok(await waitFor(() => snapshots.at(-1)?.cancelled.includes(claimed[1])), 'the PC sees the cancel');
  assert.ok(await waitFor(() => server.activeCount === 0));
  assert.deepEqual([...new Set(work)].sort(), [0, 1], 'trackWork hears the running count');
});

test('the bridge rejects a bad token, a missing hello and an oversized frame', async (t) => {
  const { endpoint } = await startBridge(t, {
    limits: { helloTimeoutMs: 150, controlFrameMaxBytes: 2048, requestFrameMaxBytes: 8192 },
  });
  const wrong = await rawClient(t, endpoint.port);
  wrong.send({ type: 'hello', v: 1, token: 'f'.repeat(64) });
  assert.equal((await wrong.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_UNAUTHORIZED');
  await wrong.closed;
  assert.equal(wrong.frames.some((frame) => frame.type === 'state'), false);

  const malformed = await rawClient(t, endpoint.port);
  malformed.send({ type: 'hello', v: 1, token: `${endpoint.token}00` });
  assert.equal((await malformed.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_UNAUTHORIZED');
  await malformed.closed;

  const silent = await rawClient(t, endpoint.port);
  const startedAt = Date.now();
  await silent.closed;
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(silent.frames, []);

  const hugeHello = await rawClient(t, endpoint.port);
  hugeHello.socket.write('x'.repeat(4096));
  assert.equal((await hugeHello.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_FRAME_TOO_LARGE');
  await hugeHello.closed;

  // After hello: a control frame past its limit is refused before it is parsed…
  const control = await authenticated(t, endpoint);
  control.socket.write(`{"type":"result","pad":"${'y'.repeat(4096)}"}\n`);
  assert.equal((await control.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_FRAME_TOO_LARGE');
  await control.closed;
  // …a request frame may be larger, up to its own limit.
  const request = await authenticated(t, endpoint);
  request.socket.write(`{"type":"req","id":"a","callbacks":[],"call":{"pad":"${'z'.repeat(16_384)}"}}\n`);
  assert.equal((await request.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_FRAME_TOO_LARGE');
  await request.closed;
  // A large frame that is not a request (by its parsed type) is refused too.
  const disguised = await authenticated(t, endpoint);
  disguised.socket.write(`{"type":"req","id":"a","pad":"${'w'.repeat(4096)}","type":"result"}\n`);
  assert.equal((await disguised.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_BAD_FRAME');
});

test('the bridge refuses unknown methods, malformed callbacks, duplicate ids and caps', async (t) => {
  const { endpoint, channel } = await startBridge(t, {
    limits: { maxRequestsPerConnection: 1, maxConnections: 3, callbackAckMs: 150 },
  });
  const snapshots = [];
  const pending = [];
  t.after(attachPc(channel, ({ id }) => pending.push(id), snapshots));
  const raw = await authenticated(t, endpoint);

  raw.send({ type: 'req', id: 'm1', callbacks: [], call: { provider: 'openai', method: 'deleteEverything' } });
  const unknown = await raw.next((frame) => frame.type === 'done' && frame.id === 'm1');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.props.code, 'MODEL_PROXY_BRIDGE_METHOD');

  raw.send({ type: 'req', id: 'c1', callbacks: ['send'], call: { provider: 'openai', method: 'send' } });
  const badNames = await raw.next((frame) => frame.type === 'done' && frame.id === 'c1');
  assert.equal(badNames.error.props.code, 'MODEL_PROXY_BRIDGE_BAD_REQUEST');

  raw.send({ type: 'req', id: 'a', callbacks: [], call: { provider: 'openai', method: 'send', model: 'm' } });
  assert.ok(await waitFor(() => pending.length === 1));
  raw.send({ type: 'req', id: 'b', callbacks: [], call: { provider: 'openai', method: 'send', model: 'm' } });
  const capped = await raw.next((frame) => frame.type === 'done' && frame.id === 'b');
  assert.equal(capped.error.props.code, 'MODEL_PROXY_BRIDGE_LIMIT');

  raw.send({ type: 'req', id: 'a', callbacks: [], call: { provider: 'openai', method: 'send', model: 'm' } });
  assert.equal((await raw.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_DUPLICATE_ID');
  await raw.closed;
  // The violating connection's running call was withdrawn upstream, never replayed.
  assert.ok(await waitFor(() => !channel.snapshot().requests.some((request) => request.id === pending[0])));
  assert.equal(pending.length, 1);

  // A client that never acknowledges a callback fails that call in bounded time.
  const mute = await authenticated(t, endpoint);
  mute.send({ type: 'req', id: 'x', callbacks: ['onTextDelta'], call: { provider: 'openai', method: 'send' } });
  assert.ok(await waitFor(() => pending.length === 2));
  op(channel, 'claim', pending[1]);
  const reply = await op(channel, 'event', pending[1], encodeModelProxyWire([{ name: 'onTextDelta', args: ['a'] }]));
  assert.equal(decodeModelProxyWire(reply.results)[0].ok, false);
  assert.ok((await mute.next((frame) => frame.type === 'event')).seq === 1);
  const timedOut = await mute.next((frame) => frame.type === 'done' && frame.id === 'x');
  assert.equal(timedOut.error.props.code, 'MODEL_PROXY_UNAVAILABLE');

  // Connection cap: the 4th concurrent socket is closed at once.
  const extra = [await rawClient(t, endpoint.port), await rawClient(t, endpoint.port)];
  const refused = await rawClient(t, endpoint.port);
  await refused.closed;
  assert.deepEqual(refused.frames, []);
  for (const client of extra) client.socket.destroy();
});

test('aggregate buffering is bounded across connections', async (t) => {
  const { endpoint } = await startBridge(t, {
    limits: { controlFrameMaxBytes: 1024, requestFrameMaxBytes: 8192, aggregateBytes: 10_000 },
  });
  const first = await authenticated(t, endpoint);
  const second = await authenticated(t, endpoint);
  // Two partial request frames, nothing running that could release budget.
  first.socket.write(`{"type":"req","id":"a","callbacks":[],"call":{"pad":"${'p'.repeat(6000)}`);
  await delay(50);
  second.socket.write(`{"type":"req","id":"b","callbacks":[],"call":{"pad":"${'q'.repeat(6000)}`);
  assert.equal((await second.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_BUSY');
  await second.closed;
  // The first one completes normally once its frame ends.
  first.socket.write('"}}\n');
  const done = await first.next((frame) => frame.type === 'done' && frame.id === 'a');
  assert.equal(done.error.props.code, 'MODEL_PROXY_BRIDGE_METHOD');
});

/** A request frame of a fixed size, so the aggregate cap admits a known count. */
const paddedReq = (model, pad = 3000) =>
  `${JSON.stringify({ type: 'req', id: model, callbacks: [], call: { provider: 'openai', method: 'send', model, pad: 'p'.repeat(pad) } })}\n`;

async function queuedBridge(t) {
  // Two padded requests fit; a third must wait for one to finish.
  const bridge = await startBridge(t, {
    limits: { controlFrameMaxBytes: 1024, requestFrameMaxBytes: 8192, aggregateBytes: 7_000 },
  });
  const claimed = [];
  const release = new Map();
  t.after(
    attachPc(bridge.channel, ({ id }) => {
      const call = decodeModelProxyWire(op(bridge.channel, 'claim', id).payload);
      claimed.push(call.model);
      release.set(call.model, () =>
        op(bridge.channel, 'resolve', id, true, encodeModelProxyWire({ content: call.model }), null)
      );
    })
  );
  return { ...bridge, claimed, release };
}

test('connections queued behind the aggregate cap are all served, in FIFO order', async (t) => {
  const { server, claimed, release, endpoint } = await queuedBridge(t);
  const clients = [];
  for (let i = 0; i < 5; i += 1) clients.push(await authenticated(t, endpoint));
  for (let i = 0; i < 5; i += 1) {
    clients[i].socket.write(paddedReq(`m${i}`));
    await delay(30);
  }
  assert.ok(await waitFor(() => claimed.length === 2));
  await delay(50);
  assert.deepEqual(claimed, ['m0', 'm1'], 'the rest wait for budget');
  // Finish in completion order m0, m1, m2, …: each frees room for the next in line.
  for (let i = 0; i < 5; i += 1) {
    assert.ok(await waitFor(() => release.has(`m${i}`)), `m${i} reached the PC; claimed ${JSON.stringify(claimed)}`);
    release.get(`m${i}`)();
    const done = await clients[i].next((frame) => frame.type === 'done' && frame.id === `m${i}`);
    assert.deepEqual(done.value, { content: `m${i}` });
  }
  assert.deepEqual(claimed, ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.ok(await waitFor(() => server.activeCount === 0));
});

test('a queued connection that closes is dropped without stalling the ones behind it', async (t) => {
  const { server, claimed, release, endpoint } = await queuedBridge(t);
  const clients = [];
  for (let i = 0; i < 5; i += 1) clients.push(await authenticated(t, endpoint));
  for (let i = 0; i < 5; i += 1) {
    clients[i].socket.write(paddedReq(`m${i}`));
    await delay(30);
  }
  assert.ok(await waitFor(() => claimed.length === 2));
  // m2 heads the queue, m3 waits behind it; m2 leaves before it is served.
  clients[2].socket.destroy();
  await clients[2].closed;
  await delay(50);
  assert.deepEqual(claimed, ['m0', 'm1']);
  release.get('m1')();
  await clients[1].next((frame) => frame.type === 'done' && frame.id === 'm1');
  assert.ok(await waitFor(() => claimed.length === 3));
  release.get('m0')();
  await clients[0].next((frame) => frame.type === 'done' && frame.id === 'm0');
  assert.ok(await waitFor(() => claimed.length === 4));
  assert.deepEqual(claimed, ['m0', 'm1', 'm3', 'm4']);
  for (const i of [3, 4]) {
    release.get(`m${i}`)();
    await clients[i].next((frame) => frame.type === 'done' && frame.id === `m${i}`);
  }
  assert.ok(await waitFor(() => server.activeCount === 0));
});

test('a queued connection is rejected busy, never left paused, once nothing running can free budget', async (t) => {
  const { server, claimed, release, endpoint } = await queuedBridge(t);
  const runner = await authenticated(t, endpoint);
  const holder = await authenticated(t, endpoint);
  const queued = await authenticated(t, endpoint);
  runner.socket.write(paddedReq('m0'));
  assert.ok(await waitFor(() => claimed.length === 1));
  // A partial frame holds budget it can only release by finishing.
  holder.socket.write(`{"type":"req","id":"h","callbacks":[],"call":{"pad":"${'h'.repeat(3700)}`);
  await delay(30);
  // Holder + m1 exceed the cap even with m0 finished.
  queued.socket.write(paddedReq('m1', 3500));
  await delay(50);
  assert.deepEqual(claimed, ['m0'], 'm1 waits while m0 runs');
  release.get('m0')();
  await runner.next((frame) => frame.type === 'done' && frame.id === 'm0');
  assert.equal((await queued.next((frame) => frame.type === 'error')).code, 'MODEL_PROXY_BRIDGE_BUSY');
  await queued.closed;
  assert.deepEqual(claimed, ['m0']);
  assert.equal(server.activeCount, 0);
});

test('a fenced or stopping daemon refuses new calls and aborts running ones', async (t) => {
  let admitted = true;
  const { endpoint, channel, server } = await startBridge(t, { admit: () => admitted });
  const snapshots = [];
  const claimed = [];
  t.after(
    attachPc(
      channel,
      ({ id }) => {
        op(channel, 'claim', id);
        claimed.push(id);
      },
      snapshots
    )
  );
  const client = bridgeClient(t, endpoint);
  assert.equal(await client.whenConnected(2_000), true);
  const running = client.request({ provider: 'openai', method: 'send', model: 'm' });
  assert.ok(await waitFor(() => claimed.length === 1));
  assert.equal(server.activeCount, 1, 'counted as in-flight work');

  admitted = false;
  await assert.rejects(client.request({ provider: 'openai', method: 'send' }), {
    code: 'MODEL_PROXY_UNAVAILABLE',
    message: /not accepting new model calls/,
  });
  server.abortAll('owner lease expired');
  await assert.rejects(running, { code: 'MODEL_PROXY_UNAVAILABLE', message: /owner lease expired/ });
  assert.ok(await waitFor(() => snapshots.at(-1)?.cancelled.includes(claimed[0])), 'the PC sees the cancel');
  assert.ok(await waitFor(() => server.activeCount === 0));

  // A new connection is refused outright while fenced.
  const refused = await rawClient(t, endpoint.port);
  await refused.closed;

  // Shutdown: running calls abort, every socket closes, close() waits for them.
  admitted = true;
  const again = bridgeClient(t, endpoint);
  const last = again.request({ provider: 'openai', method: 'send', model: 'm' });
  assert.ok(await waitFor(() => claimed.length === 2));
  await server.close('daemon shutdown');
  await assert.rejects(last, { code: 'MODEL_PROXY_UNAVAILABLE' });
  assert.equal(server.activeCount, 0);
  assert.equal(server.connectionCount, 0);
  assert.ok(snapshots.at(-1)?.cancelled.includes(claimed[1]));
});

test('providers built on a closed channel are never reused by the next run (identical PC config)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-bridge-registry-'));
  dirs.push(dir);
  useEnv(t, { MIXDOG_MODEL_PROXY: 'client', MIXDOG_USAGE_LEDGER_PATH: join(dir, 'ledger.sqlite') });
  t.after(() => closeUsageLedgers());
  _resetModelProxyProviderConfigForTest();
  t.after(() => _resetModelProxyProviderConfigForTest());

  const runs = [];
  async function headlessRun(label) {
    const { endpoint, channel, server } = await startBridge(t);
    const sent = [];
    const detach = attachPc(channel, ({ id }) => {
      const call = decodeModelProxyWire(op(channel, 'claim', id).payload);
      sent.push(call.method);
      const value =
        call.method === 'providerConfig'
          ? { ready: true, providers: { openai: { enabled: true } } }
          : { content: `answer ${label}`, usage: { inputTokens: 1, outputTokens: 1 } };
      op(channel, 'resolve', id, true, encodeModelProxyWire(value), null);
    });
    const client = new ModelProxyBridgeChannel(endpoint);
    const restore = installModelProxyChannel(client);
    try {
      assert.equal(getModelProxyChannel(), client);
      await initProviders({ ignored: { enabled: true } });
      const result = await getProvider('openai').send([{ role: 'user', content: 'hi' }], 'gpt-test', undefined, {});
      runs.push({ label, content: result.content, sent });
    } finally {
      restore();
      client.dispose();
      detach();
      await server.close();
    }
  }
  const original = getModelProxyChannel();
  await headlessRun('page 1');
  assert.equal(getModelProxyChannel(), original, 'the boundary channel is restored');
  await headlessRun('page 2');
  assert.deepEqual(runs, [
    { label: 'page 1', content: 'answer page 1', sent: ['providerConfig', 'send'] },
    { label: 'page 2', content: 'answer page 2', sent: ['providerConfig', 'send'] },
  ]);
});
