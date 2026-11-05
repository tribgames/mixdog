// Discovery, core launch, the loopback WebSocket connector and the management client, against real sockets and files.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { connect } from '../../../packages/protocol-client/src/index.ts';
import { render as renderMethodArgs } from '../../../scripts/gen-session-method-args.mjs';
import { stopCoreForRuntimeRoot } from './core-control.mjs';
import { CoreDiscoveryError, parseDiscovery, readCoreDiscovery, rpcEndpoint } from './discovery.mjs';
import { ensureCore } from './ensure-core.mjs';
import { createWebSocketConnector } from './ws-connector.mjs';

const OPTIONS = JSON.parse(
  readFileSync(new URL('../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);

const document = (state, extra = {}) =>
  JSON.stringify({
    pid: 4242,
    endpoints: { session: { port: 7001, token: 'tok' } },
    core: {
      version: '1.4.6',
      build: 'b1',
      instanceId: 'i1',
      processStartTime: '1',
      state,
      control: { port: 7001 },
      ...(state === 'serving' ? { rpc: { port: 7002 } } : {}),
      ...extra,
    },
  });

const tempDir = (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-session-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('discovery names the RPC listener only while serving, and the control listener always', () => {
  const serving = parseDiscovery(document('serving'), 'daemon.json');
  assert.deepEqual(rpcEndpoint(serving), { port: 7002, token: 'tok' });
  const draining = parseDiscovery(document('draining', { drain: { drainId: 'd1' } }), 'daemon.json');
  assert.throws(() => rpcEndpoint(draining), { code: 'noRpc' });
  assert.equal(draining.controlPort, 7001);
  assert.equal(draining.drain.drainId, 'd1');
  assert.throws(() => parseDiscovery('{"pid":1}', 'daemon.json'), { code: 'malformed' });
  assert.throws(() => parseDiscovery('not json', 'daemon.json'), CoreDiscoveryError);
});

test('reading discovery reports an absent core as such', async (context) => {
  const dir = tempDir(context);
  await assert.rejects(readCoreDiscovery(join(dir, 'daemon.json')), { code: 'absent' });
  writeFileSync(join(dir, 'daemon.json'), document('serving'));
  assert.equal((await readCoreDiscovery(join(dir, 'daemon.json'))).rpcPort, 7002);
});

test('ensureCore starts a core once when none runs and waits until discovery says serving', async () => {
  const states = [null, null, 'booting', 'migrating', 'serving'];
  const launched = [];
  const found = await ensureCore({
    readDiscovery: async () => {
      const state = states.shift();
      if (state === null) throw new CoreDiscoveryError('absent', 'none');
      return parseDiscovery(document(state), 'daemon.json');
    },
    launch: async () => launched.push('mixdogd serve'),
    sleep: async () => {},
  });
  assert.equal(found.state, 'serving');
  assert.deepEqual(launched, ['mixdogd serve']);
});

test('ensureCore attaches to a serving core without starting one, and fails at once on a blocked core', async () => {
  const launch = async () => assert.fail('must not launch');
  const serving = await ensureCore({ readDiscovery: async () => parseDiscovery(document('serving'), 'd'), launch });
  assert.equal(serving.rpcPort, 7002);
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => parseDiscovery(document('blocked', { blocked: { kind: 'undecidable', pid: 9 } }), 'd'),
      launch,
      sleep: async () => assert.fail('a blocked core is the user\'s decision, not waited out'),
    }),
    /core is not ready: the core is blocked/
  );
});

test('ensureCore gives up when the core never serves within the bound', async () => {
  let clock = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => parseDiscovery(document('draining', { drain: {} }), 'd'),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      readyTimeoutMs: 500,
    }),
    /the core is draining/
  );
});

function listen(context, onConnection) {
  const seen = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    seen.push(request.headers);
    if (request.headers.authorization !== 'Bearer tok') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      context.after(() => {
        wss.clients.forEach((client) => client.terminate());
        server.close();
      });
      resolve({ port: server.address().port, seen });
    });
  });
}

const discoveryFor = (port, token = 'tok') => async () =>
  parseDiscovery(
    JSON.stringify({
      pid: 1,
      endpoints: { session: { port, token } },
      core: { state: 'serving', control: { port }, rpc: { port } },
    }),
    'daemon.json'
  );

test('the connector opens ws://127.0.0.1/rpc with the bearer token and no Origin, and maps frames and close', async (context) => {
  const { port, seen } = await listen(context, (ws) => {
    ws.on('message', (data) => ws.send(`echo:${data}`));
    ws.on('close', () => {});
    setTimeout(() => ws.close(4002, 'version'), 60);
  });
  const frames = [];
  const closed = new Promise((resolve) => {
    createWebSocketConnector({ readDiscovery: discoveryFor(port) })
      .open({ id: 'local' }, { frame: (text) => frames.push(text), closed: (code, reason) => resolve({ code, reason }) })
      .then((writer) => writer.send('hello'));
  });
  assert.deepEqual(await closed, { code: 4002, reason: 'version' });
  assert.deepEqual(frames, ['echo:hello']);
  assert.equal(seen[0].authorization, 'Bearer tok');
  assert.equal(seen[0].origin, undefined);
  assert.equal(seen[0].upgrade, 'websocket');
});

test('a refused upgrade rejects the open instead of reporting a close', async (context) => {
  const { port } = await listen(context, () => {});
  await assert.rejects(
    createWebSocketConnector({ readDiscovery: discoveryFor(port, 'wrong') }).open({ id: 'local' }, {
      frame: () => assert.fail('no frame'),
      closed: () => assert.fail('never opened'),
    }),
    /HTTP 401/
  );
});

test('the client library completes its handshake over the loopback WebSocket', async (context) => {
  const received = [];
  const { port } = await listen(context, (ws) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      if (frame.method === 'initialize') {
        ws.send(JSON.stringify({ id: frame.id, result: { ...OPTIONS.initializeResult, serverInstanceId: 'live' } }));
      }
    });
  });
  const client = await connect({
    target: { id: 'local' },
    connector: createWebSocketConnector({ readDiscovery: discoveryFor(port) }),
    clientInfo: OPTIONS.clientInfo,
    capabilities: {},
    clock: { sleep: () => Promise.resolve() },
    random: () => 0.5,
  });
  context.after(() => client.close());
  assert.equal(client.server.serverInstanceId, 'live');
  await client.close();
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(received.map((frame) => frame.method), ['initialize', 'initialized']);
});

test('stopping a core posts stop{whenIdle} to the control listener with the discovery token and waits for exit', async (context) => {
  const dir = tempDir(context);
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  writeFileSync(
    join(dir, 'daemon.json'),
    JSON.stringify({
      pid: 4242,
      endpoints: { session: { port, token: 'tok' } },
      core: { state: 'serving', control: { port }, rpc: { port: port + 1 } },
    })
  );
  let probes = 0;
  const stopped = await stopCoreForRuntimeRoot(dir, { waitForExit: true, timeoutMs: 2000, pidAlive: () => ++probes < 3 });
  assert.equal(stopped, true);
  assert.deepEqual(requests, [
    { method: 'POST', url: '/mgmt/stop', authorization: 'Bearer tok', body: { mode: 'whenIdle', reason: 'quit' } },
  ]);
  assert.equal(await stopCoreForRuntimeRoot(join(dir, 'nowhere')), false);
});

test('the TUI entry point attaches to a serving core found through discovery and shows its transcript', async (context) => {
  const dir = tempDir(context);
  const sent = [];
  const { port } = await listen(context, (ws) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      sent.push(frame.method);
      const reply = (result) => ws.send(JSON.stringify({ id: frame.id, result }));
      const thread = { id: 't1', preview: '', title: 't1', updatedAt: 1, messageCount: 1, cwd: '/work', classification: {} };
      if (frame.method === 'initialize') reply({ ...OPTIONS.initializeResult, serverInstanceId: 'live' });
      else if (frame.method === 'thread/start') reply({ thread });
      else if (frame.method === 'thread/resume') {
        reply({ thread, subscription: { id: 's', mode: 'snapshot', epoch: 'e1', startSeq: 11 } });
        ws.send(
          JSON.stringify({
            method: 'thread/snapshot',
            params: { thread, state: {}, items: [{ type: 'agentMessage', id: 'a0', text: 'from the core' }], hasOlder: false },
            feed: { id: 't1', epoch: 'e1', seq: 10 },
          })
        );
      } else if (frame.method === 'thread/unsubscribe') reply({});
    });
  });
  writeFileSync(
    join(dir, 'daemon.json'),
    JSON.stringify({
      pid: process.pid,
      endpoints: { session: { port, token: 'tok' } },
      core: { state: 'serving', control: { port }, rpc: { port } },
    })
  );
  const previousRoot = process.env.MIXDOG_RUNTIME_ROOT;
  process.env.MIXDOG_RUNTIME_ROOT = dir;
  context.after(() => {
    if (previousRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = previousRoot;
  });
  const { createSessionRuntime } = await import('../../tui/session.mjs');
  const store = await createSessionRuntime({ cwd: '/work' });
  assert.equal(store.isRemoteSession, true);
  assert.equal(store.getState().cwd, '/work');
  assert.equal(store.getState().items[0].text, 'from the core');
  await store.dispose();
  assert.deepEqual(sent, ['initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/unsubscribe']);
});

test('the generated method-argument table matches the protocol types', async () => {
  const file = new URL('./method-args.generated.mjs', import.meta.url);
  assert.equal(readFileSync(file, 'utf8'), await renderMethodArgs());
});
