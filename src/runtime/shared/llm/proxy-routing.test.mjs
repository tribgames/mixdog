// The network proxy policy end to end: the same recording proxy sees (or does
// not see) fetch, the OpenAI WebSocket and Cursor's HTTP/2. Destinations are
// TEST-NET addresses (203.0.113.0/24): never local, never reachable, so a
// request that is not tunnelled by the proxy cannot reach anything.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsConnection } from '../../agent/orchestrator/providers/openai-ws-connect.mjs';
import { openCursorStream } from '../../agent/orchestrator/providers/cursor-wire-transport.mjs';
import { eventually } from '../watched-file-cache.test-helpers.mjs';
import { _resetProxySettingForTest, currentProxySetting, normalizeNetworkProxy } from './proxy-policy.mjs';
import { adoptEnvProxy, adoptPrivateProxy, createProxyDispatcher, getLlmDispatcher } from './http-agent.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-routing-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => {
  _resetProxySettingForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

const PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
];
const REMOTE = '203.0.113.9';

/** Store the network proxy setting the way the settings API does (a new file each time), and wait for the watch event to deliver it. */
async function configure(networkProxy) {
  const file = join(dataDir, 'mixdog-config.json');
  const next = `${file}.next`;
  writeFileSync(next, JSON.stringify({ agent: networkProxy ? { networkProxy } : {} }));
  renameSync(next, file);
  const wanted = normalizeNetworkProxy(networkProxy);
  await eventually(() => JSON.stringify(currentProxySetting()) === JSON.stringify(wanted));
}

/** Run `fn` with a clean proxy environment, `env` applied, and the previous global dispatcher restored. */
async function isolated(env, fn) {
  const saved = PROXY_ENV.map((key) => [key, process.env[key]]);
  for (const key of PROXY_ENV) delete process.env[key];
  Object.assign(process.env, env);
  const previous = getGlobalDispatcher();
  try {
    await fn();
  } finally {
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    if (owned !== previous) await owned.close();
    adoptPrivateProxy(null);
    await configure(null);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A local server standing for the AI service; `hits` counts what reached it. */
async function target() {
  const hits = { http: 0, sockets: 0 };
  const server = http.createServer((_req, res) => {
    hits.http += 1;
    res.end('target');
  });
  server.on('connection', () => (hits.sockets += 1));
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo ${data}`)));
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const h2 = http2.createServer();
  const sessions = { count: 0 };
  h2.on('session', () => (sessions.count += 1));
  h2.on('stream', (stream) => {
    stream.respond({ ':status': 200 });
    stream.end('pong');
  });
  h2.listen(0, '0.0.0.0');
  await once(h2, 'listening');
  return {
    hits,
    sessions,
    port: server.address().port,
    h2Port: h2.address().port,
    close: () => {
      sockets.close();
      server.closeAllConnections();
      server.close();
      h2.close();
    },
  };
}

/** A proxy that records each request line and forwards it to the local target (every CONNECT lands there). */
async function recordingProxy(destination) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const upstream = http.request(
      { host: '127.0.0.1', port: destination.port, path: new URL(req.url).pathname, method: req.method },
      (answer) => {
        res.writeHead(answer.statusCode);
        answer.pipe(res);
      }
    );
    upstream.end();
  });
  server.on('connect', (req, socket, head) => {
    requests.push(`CONNECT ${req.url}`);
    // Port 9 is the discard port the tests name for WebSocket; HTTP/2 names 10.
    const port = req.url.endsWith(':10') ? destination.h2Port : destination.port;
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The address of a port nothing listens on. */
async function deadProxyUrl() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return `http://127.0.0.1:${port}`;
}

const text = async (url) => (await fetch(url, { signal: AbortSignal.timeout(5_000) })).text();

async function openSocket(url) {
  const socket = new WebSocket(url, { createConnection: createWsConnection, handshakeTimeout: 5_000 });
  const outcome = await new Promise((resolve) => {
    socket.once('open', () => resolve('open'));
    socket.once('error', resolve);
  });
  return { socket, outcome };
}

/** One Cursor stream round trip: the bytes it received, or the error that ended it. */
function cursorRoundTrip(url) {
  return new Promise((resolve) => {
    const stream = openCursorStream({ accessToken: 'token', path: '/probe', url });
    const received = [];
    stream.onData((chunk) => received.push(chunk));
    stream.onClose((error) => resolve({ error, data: Buffer.concat(received).toString() }));
    stream.write(Buffer.from('ping'));
  });
}

test('manual mode sends fetch through the proxy, the exceptions go direct, and nothing else is exempt', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  try {
    await isolated({}, async () => {
      await configure({ mode: 'manual', url: proxy.url, exceptions: 'localhost, 127.0.0.1, ::1' });
      getLlmDispatcher();
      assert.equal(await text(`http://${REMOTE}:8080/v1/models`), 'target');
      assert.deepEqual(proxy.requests, [`GET http://${REMOTE}:8080/v1/models`]);
      await assert.rejects(fetch(`https://${REMOTE}/v1/models`, { signal: AbortSignal.timeout(5_000) }));
      assert.equal(proxy.requests[1], `CONNECT ${REMOTE}:443`);

      assert.equal(await text(`http://127.0.0.1:${service.port}/`), 'target');
      assert.equal(proxy.requests.length, 2, 'an excepted host is not sent through the proxy');
      // 127.0.0.2 is loopback but not in the list: manual mode has no other bypass.
      assert.equal(await text(`http://127.0.0.2:${service.port}/`), 'target');
      assert.equal(proxy.requests[2], `GET http://127.0.0.2:${service.port}/`);
    });
  } finally {
    proxy.close();
    service.close();
  }
});

test('a change of the setting applies to the next connection, without a restart', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  const toService = new Agent({ connect: (_options, callback) => {
    const socket = net.connect(service.port, '127.0.0.1');
    socket.once('connect', () => callback(null, socket));
    socket.once('error', (error) => callback(error, null));
  } });
  try {
    await isolated({}, async () => {
      setGlobalDispatcher(createProxyDispatcher({ direct: toService }));
      await configure({ mode: 'manual', url: proxy.url });
      assert.equal(await text(`http://${REMOTE}:8080/a`), 'target');
      assert.equal(proxy.requests.length, 1);
      await configure({ mode: 'off' });
      assert.equal(await text(`http://${REMOTE}:8080/b`), 'target');
      assert.equal(proxy.requests.length, 1, 'the second request went direct');
      await configure({ mode: 'manual', url: proxy.url });
      assert.equal(await text(`http://${REMOTE}:8080/c`), 'target');
      assert.equal(proxy.requests.length, 2);
    });
  } finally {
    proxy.close();
    service.close();
  }
});

test('manual mode tunnels the OpenAI WebSocket through the proxy and connects excepted hosts directly', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  try {
    await isolated({}, async () => {
      await configure({ mode: 'manual', url: proxy.url, exceptions: 'localhost, 127.0.0.1, ::1' });
      const viaProxy = await openSocket(`ws://${REMOTE}:9/socket`);
      assert.equal(viaProxy.outcome, 'open');
      viaProxy.socket.send('hi');
      const [reply] = await once(viaProxy.socket, 'message');
      assert.equal(reply.toString(), 'echo hi');
      viaProxy.socket.close();
      assert.deepEqual(proxy.requests, [`CONNECT ${REMOTE}:9`]);

      const direct = await openSocket(`ws://127.0.0.1:${service.port}/socket`);
      assert.equal(direct.outcome, 'open');
      direct.socket.close();
      assert.equal(proxy.requests.length, 1, 'an excepted host does not use the proxy');
    });
  } finally {
    proxy.close();
    service.close();
  }
});

test('manual mode tunnels Cursor HTTP/2 through the proxy and connects excepted hosts directly', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  try {
    await isolated({}, async () => {
      await configure({ mode: 'manual', url: proxy.url, exceptions: 'localhost, 127.0.0.1, ::1' });
      const viaProxy = await cursorRoundTrip(`http://${REMOTE}:10`);
      assert.equal(viaProxy.error, null);
      assert.equal(viaProxy.data, 'pong');
      assert.deepEqual(proxy.requests, [`CONNECT ${REMOTE}:10`]);

      const direct = await cursorRoundTrip(`http://127.0.0.1:${service.h2Port}`);
      assert.equal(direct.data, 'pong');
      assert.equal(proxy.requests.length, 1, 'an excepted host does not use the proxy');
    });
  } finally {
    proxy.close();
    service.close();
  }
});

test('an unreachable manual proxy fails every path and never falls back to a direct connection', async () => {
  const service = await target();
  const dead = await deadProxyUrl();
  try {
    await isolated({}, async () => {
      // 127.0.0.2 is reachable directly (the service listens on every address), but manual mode does not except it.
      await configure({ mode: 'manual', url: dead, exceptions: 'localhost' });
      getLlmDispatcher();
      await assert.rejects(fetch(`http://127.0.0.2:${service.port}/`, { signal: AbortSignal.timeout(5_000) }));

      const socket = await openSocket(`ws://127.0.0.2:${service.port}/socket`);
      assert.notEqual(socket.outcome, 'open');

      const stream = await cursorRoundTrip(`http://127.0.0.2:${service.h2Port}`);
      assert.ok(stream.error, 'the Cursor stream failed');
      assert.equal(stream.data, '');

      assert.equal(service.hits.http, 0);
      assert.equal(service.hits.sockets, 0, 'nothing connected to the service directly');
      assert.equal(service.sessions.count, 0);
    });
  } finally {
    service.close();
  }
});

test('manual mode without an address fails the request instead of connecting directly', async () => {
  const service = await target();
  try {
    await isolated({}, async () => {
      await configure({ mode: 'manual', url: '' });
      getLlmDispatcher();
      await assert.rejects(fetch(`http://127.0.0.2:${service.port}/`, { signal: AbortSignal.timeout(5_000) }));
      assert.equal(service.hits.sockets, 0);
    });
  } finally {
    service.close();
  }
});

test('off connects directly whatever the environment and the system proxy say', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  const toService = new Agent({ connect: (_options, callback) => {
    const socket = net.connect(service.port, '127.0.0.1');
    socket.once('connect', () => callback(null, socket));
    socket.once('error', (error) => callback(error, null));
  } });
  try {
    const env = { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url };
    await isolated(env, async () => {
      adoptPrivateProxy(() => ({ proxy: proxy.url }));
      setGlobalDispatcher(createProxyDispatcher({ direct: toService }));
      await configure({ mode: 'off' });
      assert.equal(await text(`http://${REMOTE}:8080/`), 'target');
      assert.deepEqual(proxy.requests, [], 'neither the variables nor the system proxy were used');
      // The same environment under `system` does use the proxy.
      await configure(null);
      assert.equal(await text(`http://${REMOTE}:8080/`), 'target');
      assert.equal(proxy.requests.length, 1);
    });
  } finally {
    proxy.close();
    service.close();
  }
});

test('NO_PROXY=* sends everything direct, over the system proxy too', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  try {
    await isolated({ NO_PROXY: '*' }, async () => {
      adoptPrivateProxy(() => ({ proxy: proxy.url }));
      // Direct to a TEST-NET address goes nowhere: the request ends, and the proxy never saw it.
      await assert.rejects(fetch(`http://${REMOTE}:8080/`, { signal: AbortSignal.timeout(500) }));
      assert.deepEqual(proxy.requests, []);
    });
  } finally {
    proxy.close();
    service.close();
  }
});

test('an ALL_PROXY-only environment is followed, and NO_PROXY is honoured', async () => {
  const service = await target();
  const proxy = await recordingProxy(service);
  try {
    await isolated({ ALL_PROXY: proxy.url, NO_PROXY: '203.0.113.10' }, async () => {
      adoptEnvProxy();
      assert.equal(await text(`http://${REMOTE}:8080/`), 'target');
      assert.deepEqual(proxy.requests, [`GET http://${REMOTE}:8080/`]);
      await assert.rejects(fetch('http://203.0.113.10:8080/', { signal: AbortSignal.timeout(500) }));
      assert.equal(proxy.requests.length, 1, 'an excepted host is not sent through the proxy');
    });
  } finally {
    proxy.close();
    service.close();
  }
});
