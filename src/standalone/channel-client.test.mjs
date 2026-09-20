import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { attachChannel } from './channel-client.mjs';

// attachChannel against a stub daemon on 127.0.0.1: passive registration, the
// notify SSE stream, tool calls with the client token, bounded reconnect after
// a stream loss, and the stale/auth/transport error classifications the
// channel worker relies on.

function stubDaemon({ pid = process.pid, registerStatus = 200 } = {}) {
  const state = { registers: [], deregisters: [], calls: [], streams: [], tokens: 0, waiters: [] };
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
        case '/client/register':
          state.registers.push(parsed);
          if (registerStatus !== 200) return json(registerStatus, { error: 'rejected' });
          state.tokens += 1;
          return json(200, { token: `tok-${state.tokens}` });
        case '/client/deregister':
          state.deregisters.push(parsed);
          return json(200, { ok: true });
        case '/call':
          state.calls.push(parsed);
          if (parsed.name === 'boom') return json(200, { error: 'exploded', code: 'E_BOOM' });
          return json(200, { result: { echo: parsed.args } });
        case '/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const stream = {
            token: url.searchParams.get('token'),
            send: (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`),
            keepalive: () => res.write(': ka\n\n'),
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

const discoveryFor = (daemon, pid = process.pid) => ({ port: daemon.port, pid, token: 'daemon-secret' });

test('attach registers passively, forwards notify frames, and calls with the client token', async () => {
  const daemon = await stubDaemon();
  const notified = [];
  const logs = [];
  try {
    const handle = await attachChannel({
      discovery: discoveryFor(daemon),
      leadPid: 4242,
      cwd: '/work',
      restoreSessionId: 'sess-1',
      onNotify: (msg) => notified.push(msg),
      log: (line) => logs.push(line),
    });
    const { registrationId, ...registration } = daemon.state.registers[0];
    assert.equal(typeof registrationId, 'string');
    assert.deepEqual(registration, { leadPid: 4242, cwd: '/work', passive: true, restoreSessionId: 'sess-1' });
    assert.equal(handle.clientToken, 'tok-1');
    assert.equal(handle.port, daemon.port);

    const stream = await daemon.stream(0);
    assert.equal(stream.token, 'tok-1');
    stream.keepalive();
    stream.send({ type: 'other', method: 'ignored' });
    stream.send({ type: 'notify', method: 'channel.event', params: { a: 1 } });
    await until(() => notified.length === 1);
    assert.deepEqual(notified, [{ type: 'notify', method: 'channel.event', params: { a: 1 } }]);

    assert.deepEqual(await handle.call('echo', { x: 1 }, { callId: 'call-1' }), { echo: { x: 1 } });
    assert.deepEqual(daemon.state.calls[0], { token: 'tok-1', name: 'echo', args: { x: 1 }, callId: 'call-1' });
    await assert.rejects(handle.call('boom'), (err) => err.message === 'exploded' && err.code === 'E_BOOM');

    await handle.close('test done');
    assert.deepEqual(daemon.state.deregisters, [{ token: 'tok-1' }]);
    assert.ok(logs.includes('detached (test done)'));
  } finally {
    await daemon.close();
  }
});

test('a stream loss on a live daemon re-registers passively with replaceToken and adopts the fresh token', async () => {
  const daemon = await stubDaemon();
  const logs = [];
  try {
    const handle = await attachChannel({ discovery: discoveryFor(daemon), log: (line) => logs.push(line) });
    const first = await daemon.stream(0);
    first.end();
    const second = await daemon.stream(1);
    assert.equal(second.token, 'tok-2');
    const reconnect = daemon.state.registers[1];
    assert.equal(reconnect.replaceToken, 'tok-1');
    assert.equal(reconnect.passive, true);
    assert.equal(typeof reconnect.registrationId, 'string');
    assert.ok(logs.some((line) => line.startsWith('sse reconnect scheduled (sse ended, attempt 1)')));

    await handle.call('echo', {});
    assert.equal(daemon.state.calls[0].token, 'tok-2');
    await handle.close();
    assert.deepEqual(daemon.state.deregisters, [{ token: 'tok-2' }]);
  } finally {
    await daemon.close();
  }
});

test('a health pid mismatch is a stale discovery, and a rejected register is an auth rejection', async () => {
  const live = await stubDaemon();
  const rejecting = await stubDaemon({ registerStatus: 401 });
  try {
    await assert.rejects(
      attachChannel({ discovery: discoveryFor(live, process.pid + 1) }),
      (err) => err.daemonDiscoveryStale === true && !err.daemonAuthRejected
    );
    assert.equal(live.state.registers.length, 0);
    await assert.rejects(
      attachChannel({ discovery: discoveryFor(rejecting) }),
      (err) => err.daemonDiscoveryStale === true && err.daemonAuthRejected === true
    );
  } finally {
    await live.close();
    await rejecting.close();
  }
});

test('a dead daemon tags calls as transport failures and signals onFatal instead of retrying', async () => {
  const daemon = await stubDaemon();
  const fatal = [];
  const handle = await attachChannel({ discovery: discoveryFor(daemon), onFatal: (reason) => fatal.push(reason) });
  await daemon.stream(0);
  await daemon.close();
  await assert.rejects(handle.call('echo', {}), (err) => err.daemonTransportError === true);
  await until(() => fatal.length === 1);
  assert.equal(daemon.state.registers.length, 1);
  await handle.close();
});
