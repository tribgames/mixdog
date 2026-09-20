import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStandaloneChannelWorker } from './channel-worker.mjs';

// The channel worker against a discovered stub daemon (no spawn): the client
// heartbeat file, attach on start, tool calls with stable call ids, transport
// failure → re-attach, notify forwarding, and detach on stop.

function stubDaemon({ failCalls = 0 } = {}) {
  const state = { registers: [], deregisters: [], calls: [], streams: [], tokens: 0, failCalls };
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
          return json(200, { status: 'ok', pid: process.pid });
        case '/client/register':
          state.registers.push(parsed);
          state.tokens += 1;
          return json(200, { token: `tok-${state.tokens}` });
        case '/client/deregister':
          state.deregisters.push(parsed);
          return json(200, { ok: true });
        case '/call':
          if (state.failCalls > 0) {
            state.failCalls -= 1;
            req.socket.destroy();
            return undefined;
          }
          state.calls.push(parsed);
          return json(200, { result: { ran: parsed.name, args: parsed.args } });
        case '/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': attached\n\n');
          state.streams.push({ send: (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`) });
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

async function workspace(context, daemonOptions) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-channel-worker-'));
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const previousRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  const daemon = await stubDaemon(daemonOptions);
  writeFileSync(
    join(runtimeRoot, 'daemon.json'),
    JSON.stringify({ pid: process.pid, endpoints: { channel: { port: daemon.port, token: 'daemon-secret' } } })
  );
  context.after(async () => {
    process.env.MIXDOG_RUNTIME_ROOT = previousRuntimeRoot;
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtimeRoot, daemon, heartbeatPath: join(runtimeRoot, 'channel-clients', `${process.pid}.json`) };
}

test('start attaches to the discovered daemon; execute routes channel tools; stop detaches and drops the heartbeat', async (context) => {
  const { root, daemon, heartbeatPath } = await workspace(context);
  const notified = [];
  const worker = createStandaloneChannelWorker({
    rootDir: join(root, 'app'),
    dataDir: join(root, 'data'),
    cwd: '/work',
    leadPid: 4242,
    getSessionId: () => 'sess_x',
    onNotify: (message) => notified.push(message),
  });
  const heartbeat = () => {
    try {
      return JSON.parse(readFileSync(heartbeatPath, 'utf8'));
    } catch {
      return null;
    }
  };
  await until(() => heartbeat()?.cwd === '/work');
  assert.equal(heartbeat().pid, process.pid);
  assert.deepEqual(worker.status(), { running: false, pid: null, pending: 0, mode: 'daemon' });
  assert.equal(worker.isChannelTool('activate_channel_bridge'), true);
  assert.equal(worker.isChannelTool('read'), false);

  assert.deepEqual(await worker.start(), { running: true, pid: process.pid, pending: 0, mode: 'daemon' });
  const { registrationId, ...registration } = daemon.state.registers[0];
  assert.equal(typeof registrationId, 'string');
  assert.deepEqual(registration, { leadPid: 4242, cwd: '/work', passive: true, restoreSessionId: 'sess_x' });

  assert.deepEqual(await worker.execute('reload_config', { a: 1 }), { ran: 'reload_config', args: { a: 1 } });
  assert.equal(daemon.state.calls[0].token, 'tok-1');
  assert.match(daemon.state.calls[0].callId, /^ch_[0-9a-f-]{36}_1$/);
  await assert.rejects(worker.execute('nope'), /unknown channel tool: nope/);

  await until(() => daemon.state.streams.length === 1);
  daemon.state.streams[0].send({ type: 'notify', method: 'channel.event', params: { n: 1 } });
  await until(() => notified.length === 1);
  assert.deepEqual(notified[0], { type: 'notify', method: 'channel.event', params: { n: 1 } });

  assert.equal(await worker.stop('bye'), true);
  assert.deepEqual(daemon.state.deregisters, [{ token: 'tok-1' }]);
  assert.equal(existsSync(heartbeatPath), false);
  assert.equal(worker.status().running, false);
  assert.equal(await worker.stop(), false, 'a second stop has nothing to detach');
});

test('a transport failure drops the stale attach and the retry re-attaches with the same call id', async (context) => {
  const { root, daemon } = await workspace(context, { failCalls: 1 });
  const worker = createStandaloneChannelWorker({ rootDir: join(root, 'app'), dataDir: join(root, 'data') });
  assert.deepEqual(await worker.execute('rebind_current_transcript', {}), {
    ran: 'rebind_current_transcript',
    args: {},
  });
  assert.equal(daemon.state.registers.length, 2, 'the failed transport re-attached');
  assert.equal(daemon.state.calls[0].token, 'tok-2');
  assert.match(daemon.state.calls[0].callId, /_1$/);
  assert.deepEqual(daemon.state.deregisters, [{ token: 'tok-1' }]);
  assert.equal(worker.status().running, true);
  await worker.stop();
});
