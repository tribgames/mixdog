import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import {
  adoptEnvProxy,
  createProxyDispatcher,
  getLlmDispatcher,
  isLocalHost,
  LOCAL_NO_PROXY,
  recycleLlmDispatcher,
  withEnvProxy,
} from './http-agent.mjs';

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
];

/** Clear the proxy env for one test; the returned function restores it. */
function isolateProxyEnv() {
  const saved = PROXY_ENV_KEYS.map((key) => [key, process.env[key]]);
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A proxy that records each request line and refuses it. */
async function recordingProxy() {
  const requests = [];
  const server = createNetServer((socket) =>
    socket.once('data', (data) => {
      requests.push(data.toString().split('\r\n')[0]);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    })
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('proxy variables gain NODE_USE_ENV_PROXY and a local NO_PROXY; explicit settings win', () => {
  assert.deepEqual(withEnvProxy({ HTTPS_PROXY: 'http://p:1' }), {
    HTTPS_PROXY: 'http://p:1',
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: LOCAL_NO_PROXY,
  });
  const entries = LOCAL_NO_PROXY.split(',');
  for (const entry of [
    'localhost',
    '127.0.0.1',
    '::1',
    '.local',
    '10.0.0.0-10.255.255.255',
    '192.168.0.0-192.168.255.255',
  ]) {
    assert.ok(entries.includes(entry), entry);
  }
  assert.deepEqual(withEnvProxy({ http_proxy: 'http://p:1', no_proxy: 'corp' }), {
    http_proxy: 'http://p:1',
    no_proxy: 'corp',
    NODE_USE_ENV_PROXY: '1',
  });
  const disabled = { HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '0' };
  assert.equal(withEnvProxy(disabled), disabled);
  const direct = { PATH: '/bin' };
  assert.equal(withEnvProxy(direct), direct);
});

test('local and LAN hosts are recognised; public hosts are not', () => {
  for (const host of [
    'localhost',
    'app.localhost',
    '127.0.0.2',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.77.5',
    '169.254.1.1',
    '[::1]',
    'fd00::5',
    'fe80::1',
    'printer',
    'nas.local',
  ]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ['auth.openai.com', '8.8.8.8', '172.32.0.1', '2001:4860::8888', 'example.local.com']) {
    assert.equal(isLocalHost(host), false, host);
  }
});

test('adoptEnvProxy routes this process through HTTPS_PROXY and marks the env for children', async () => {
  const restoreEnv = isolateProxyEnv();
  const previous = getGlobalDispatcher();
  const proxy = await recordingProxy();
  process.env.HTTPS_PROXY = proxy.url;
  try {
    assert.equal(adoptEnvProxy(), true);
    assert.equal(process.env.NODE_USE_ENV_PROXY, '1');
    assert.equal(process.env.NO_PROXY, LOCAL_NO_PROXY);
    await assert.rejects(fetch('https://auth.example.invalid/oauth/token', { signal: AbortSignal.timeout(10_000) }));
    assert.deepEqual(proxy.requests, ['CONNECT auth.example.invalid:443 HTTP/1.1']);
    // Adopted once per process.
    assert.equal(adoptEnvProxy(), false);
  } finally {
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    await owned.close();
    proxy.close();
    restoreEnv();
  }
});

test('under a proxy, loopback and LAN targets connect directly and public hosts go through the proxy', async () => {
  const restoreEnv = isolateProxyEnv();
  const previous = getGlobalDispatcher();
  const proxy = await recordingProxy();
  // NO_PROXY stays unset: the bypass below is the dispatcher's own.
  process.env.HTTP_PROXY = proxy.url;
  process.env.HTTPS_PROXY = proxy.url;
  // The direct side really connects, but every LAN address lands on this
  // local server; the connector records the address it was asked for.
  const server = createServer((_req, res) => res.end('direct'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dialed = [];
  const direct = new Agent({
    connect: (options, callback) => {
      dialed.push(options.hostname.replace(/^\[(.*)\]$/, '$1'));
      const socket = netConnect(server.address().port, '127.0.0.1');
      socket.once('connect', () => callback(null, socket));
      socket.once('error', (error) => callback(error, null));
    },
  });
  const dispatcher = createProxyDispatcher({ direct });
  setGlobalDispatcher(dispatcher);
  try {
    const local = [
      'http://127.0.0.2:8080/',
      'http://192.168.77.5:8080/',
      'http://10.1.2.3:8080/',
      'http://[fd00::5]:8080/',
      'http://printer:8080/',
      'http://nas.local:8080/',
    ];
    for (const url of local) {
      assert.equal(await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text(), 'direct', url);
    }
    assert.deepEqual(dialed, ['127.0.0.2', '192.168.77.5', '10.1.2.3', 'fd00::5', 'printer', 'nas.local']);

    // The proxy refuses both: a failed tunnel (https) or its 502 answer (http).
    await assert.rejects(fetch('https://api.example.com/v1/models', { signal: AbortSignal.timeout(10_000) }));
    const viaProxy = await fetch('http://public.example.com:8080/', { signal: AbortSignal.timeout(10_000) }).then(
      (response) => response.status,
      () => 'rejected'
    );
    assert.ok(viaProxy === 502 || viaProxy === 'rejected', String(viaProxy));
    assert.equal(dialed.length, local.length, 'no public host was dialed directly');
    assert.equal(proxy.requests.length, 2);
    assert.match(proxy.requests[0], /^CONNECT api\.example\.com:443 /);
    assert.match(proxy.requests[1], /public\.example\.com:8080/);
  } finally {
    setGlobalDispatcher(previous);
    await dispatcher.close();
    server.close();
    proxy.close();
    restoreEnv();
  }
});

test('pool replacement permits SDK retries and drains another active request', async () => {
  const proxyKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NODE_USE_ENV_PROXY',
  ];
  const saved = proxyKeys.map((key) => [key, process.env[key]]);
  for (const key of proxyKeys) delete process.env[key];
  const previous = getGlobalDispatcher();
  let pendingResponse;
  let markPending;
  const pending = new Promise((resolve) => {
    markPending = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === '/pending') {
      pendingResponse = res;
      markPending();
    } else {
      res.end('fresh');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    getLlmDispatcher();
    const inFlight = fetch(`${base}/pending`).then((response) => response.text());
    await pending;
    assert.equal(recycleLlmDispatcher(), true);
    // Deliberately do NOT call getLlmDispatcher again: SDK retries use fetch.
    assert.equal(await (await fetch(`${base}/next`)).text(), 'fresh');
    pendingResponse.end('preserved');
    assert.equal(await inFlight, 'preserved');

    // A second generation must also remain usable after repeated failures.
    assert.equal(recycleLlmDispatcher(), true);
    assert.equal(await (await fetch(`${base}/again`)).text(), 'fresh');
  } finally {
    pendingResponse?.end();
    const owned = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    await owned.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('pool replacement preserves a custom global dispatcher', async () => {
  const previous = getGlobalDispatcher();
  let dispatched = 0;
  class CustomAgent extends Agent {
    dispatch(options, handler) {
      dispatched += 1;
      return super.dispatch(options, handler);
    }
  }
  const custom = new CustomAgent();
  const server = createServer((_req, res) => res.end('custom'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  setGlobalDispatcher(custom);
  try {
    assert.equal(getLlmDispatcher(), undefined);
    assert.equal(recycleLlmDispatcher(), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(), 'custom');
    assert.equal(dispatched, 1);
  } finally {
    setGlobalDispatcher(previous);
    await custom.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
