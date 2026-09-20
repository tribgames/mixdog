import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachSession } from './session-client.mjs';
import { SESSION_PROTOCOL, SESSION_REVISION } from './session-wire.mjs';

// attachSession against a stub daemon: registration (with 5xx retry and 4xx
// stop), frames on the event stream, calls, backed-off stream reconnects with
// their disconnect/reconnect reports, the fatal paths (token rejection, daemon
// replaced, reconnect budget exhausted), and deregister on close.

function stubDaemon({ pid = process.pid, registerStatuses = [] } = {}) {
  const state = { registers: [], deregisters: [], calls: [], streams: [], tokens: 0, waiters: [], eventStatus: 200 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parsed = body ? JSON.parse(body) : null;
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      switch (url.pathname) {
        case '/health':
          return json(200, { status: 'ok', pid });
        case '/client/register': {
          state.registers.push(parsed);
          const status = registerStatuses.shift() ?? 200;
          if (status !== 200) return json(status, { error: `register ${status}` });
          state.tokens += 1;
          return json(200, { token: `tok-${state.tokens}`, protocol: SESSION_PROTOCOL, revision: 42 });
        }
        case '/client/deregister':
          state.deregisters.push(parsed);
          return json(200, { ok: true });
        case '/call':
          state.calls.push(parsed);
          if (parsed.name === 'session.boom') return json(200, { error: 'exploded', code: 'E_BOOM' });
          return json(200, { result: { echo: parsed.args } });
        case '/events': {
          if (state.eventStatus !== 200) return json(state.eventStatus, { error: 'no' });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': attached\n\n');
          const stream = {
            token: url.searchParams.get('token'),
            send: (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`),
            end: () => res.end(),
          };
          state.streams.push(stream);
          for (const waiter of state.waiters.splice(0)) waiter();
          return undefined;
        }
        default:
          return json(404, { error: 'not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        port: server.address().port,
        stream: (index) =>
          new Promise((done) => {
            const check = () => (state.streams[index] ? done(state.streams[index]) : state.waiters.push(check));
            check();
          }),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function isolatedRuntimeRoot(context) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-session-attach-'));
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const previous = process.env.MIXDOG_RUNTIME_ROOT;
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  context.after(() => {
    process.env.MIXDOG_RUNTIME_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return runtimeRoot;
}

const discoveryFor = (daemon) => ({ port: daemon.port, token: 'daemon-secret', pid: process.pid });
const fastStream = { streamReconnectBaseMs: 10, streamReconnectMaxMs: 20, streamReconnectBudgetMs: 2000 };

test('attach registers with the wire identity, streams frames, calls with the client token, and deregisters on close', async (context) => {
  isolatedRuntimeRoot(context);
  const daemon = await stubDaemon({ registerStatuses: [500] });
  const frames = [];
  const logs = [];
  try {
    const handle = await attachSession({
      discovery: discoveryFor(daemon),
      leadPid: 4242,
      cwd: '/work',
      clientKind: 'desktop',
      registrationId: 'reg-1',
      onFrame: (frame) => frames.push(frame),
      log: (line) => logs.push(line),
    });
    assert.equal(daemon.state.registers.length, 2, 'a 5xx register is retried');
    assert.deepEqual(daemon.state.registers[1], {
      leadPid: 4242,
      cwd: '/work',
      lifecycle: true,
      clientKind: 'desktop',
      registrationId: 'reg-1',
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
    });
    assert.equal(handle.clientToken, 'tok-1');
    assert.equal(handle.port, daemon.port);
    assert.equal(handle.pid, process.pid);
    assert.equal(handle.protocol, SESSION_PROTOCOL);
    assert.equal(handle.revision, 42);

    const stream = await daemon.stream(0);
    assert.equal(stream.token, 'tok-1');
    stream.send({ type: 'session.snapshot', n: 1 });
    await until(() => frames.length === 1);
    assert.deepEqual(frames, [{ type: 'session.snapshot', n: 1 }]);

    assert.deepEqual(await handle.call('session.submit', { text: 'hi' }, { callId: 'c1' }), { echo: { text: 'hi' } });
    assert.deepEqual(daemon.state.calls[0], {
      token: 'tok-1',
      name: 'session.submit',
      args: { text: 'hi' },
      callId: 'c1',
    });
    await assert.rejects(handle.call('session.boom'), (err) => err.message === 'exploded' && err.code === 'E_BOOM');

    await handle.close('done');
    assert.deepEqual(daemon.state.deregisters, [{ token: 'tok-1' }]);
    assert.ok(logs.includes('detached (done)'));
    await handle.close('again');
    assert.equal(daemon.state.deregisters.length, 1, 'close is idempotent');
  } finally {
    await daemon.close();
  }
});

test('a 4xx registration is not retried and surfaces its status', async (context) => {
  isolatedRuntimeRoot(context);
  const daemon = await stubDaemon({ registerStatuses: [403] });
  try {
    await assert.rejects(attachSession({ discovery: discoveryFor(daemon) }), (err) => err.statusCode === 403);
    assert.equal(daemon.state.registers.length, 1);
  } finally {
    await daemon.close();
  }
});

test('a lost stream reconnects with backoff and reports the disconnect and the recovery', async (context) => {
  isolatedRuntimeRoot(context);
  const daemon = await stubDaemon();
  const disconnects = [];
  const reconnects = [];
  const fatal = [];
  try {
    const handle = await attachSession({
      discovery: discoveryFor(daemon),
      ...fastStream,
      onStreamDisconnect: (info) => disconnects.push(info),
      onStreamReconnect: (info) => reconnects.push(info),
      onFatal: (reason) => fatal.push(reason),
    });
    const first = await daemon.stream(0);
    first.end();
    const second = await daemon.stream(1);
    assert.equal(second.token, 'tok-1', 'the same registration reopens the stream');
    await until(() => reconnects.length === 1);
    assert.deepEqual(disconnects, [{ reason: 'sse ended' }]);
    assert.equal(reconnects[0].reason, 'sse ended');
    assert.equal(reconnects[0].attempt, 1);
    assert.ok(reconnects[0].downtimeMs >= 0);
    assert.deepEqual(fatal, []);
    assert.equal(daemon.state.registers.length, 1, 'a stream reconnect never re-registers');
    await handle.close();
  } finally {
    await daemon.close();
  }
});

test('a token rejection on the stream is fatal, and so is a replaced daemon behind the discovery file', async (context) => {
  const runtimeRoot = isolatedRuntimeRoot(context);
  const rejecting = await stubDaemon();
  const replacedFrom = await stubDaemon();
  const replacement = await stubDaemon();
  try {
    rejecting.state.eventStatus = 401;
    const fatal = [];
    const handle = await attachSession({ discovery: discoveryFor(rejecting), onFatal: (reason) => fatal.push(reason) });
    await until(() => fatal.length === 1);
    assert.equal(fatal[0], 'bad sse status 401');
    await handle.close();

    const replacedFatal = [];
    const replacedHandle = await attachSession({
      discovery: discoveryFor(replacedFrom),
      ...fastStream,
      onFatal: (reason) => replacedFatal.push(reason),
    });
    const stream = await replacedFrom.stream(0);
    writeFileSync(
      join(runtimeRoot, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        endpoints: { session: { port: replacement.port, token: 'new-secret' } },
      })
    );
    stream.end();
    await until(() => replacedFatal.length === 1);
    assert.match(replacedFatal[0], /sse ended; daemon replaced oldPid=\d+ oldPort=\d+ newPid=\d+ newPort=\d+/);
    assert.equal(replacedFrom.state.streams.length, 1, 'no reconnect against the retired daemon');
    await replacedHandle.close();
  } finally {
    await rejecting.close();
    await replacedFrom.close();
    await replacement.close();
  }
});

test('a daemon that stays unreachable exhausts the reconnect budget and signals fatal once', async (context) => {
  isolatedRuntimeRoot(context);
  const daemon = await stubDaemon();
  const fatal = [];
  const disconnects = [];
  const handle = await attachSession({
    discovery: discoveryFor(daemon),
    streamReconnectBaseMs: 10,
    streamReconnectMaxMs: 20,
    streamReconnectBudgetMs: 150,
    onStreamDisconnect: (info) => disconnects.push(info),
    onFatal: (reason) => fatal.push(reason),
  });
  await daemon.stream(0);
  await daemon.close();
  await until(() => fatal.length === 1);
  assert.match(fatal[0], /reconnect budget exhausted after \d+ms/);
  assert.equal(disconnects.length, 1);
  await handle.close();
});
