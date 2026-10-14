import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createMcpTransport as buildTransport } from './client-transport.mjs';
import { createMcpOAuth as buildOAuth } from './oauth.mjs';
import { runBoundedHandshake } from './client-handshake.mjs';

function memoryStore(values = new Map()) {
  return {
    values,
    getSecretAsync: async (key) => values.get(key),
    setSecretAsync: async (key, value) => { values.set(key, value); },
    deleteSecretAsync: async (key) => { values.delete(key); },
  };
}
const createMcpOAuth = (options) => buildOAuth({ credentialStore: memoryStore(), interactive: true, ...options });
const createMcpTransport = (options) => buildTransport({
  ...options, oauthOptions: { credentialStore: memoryStore(), interactive: true, ...options.oauthOptions },
});

async function fixture(t, { type = 'http', header = null } = {}) {
  let origin;
  let metadata;
  let authorization;
  let exchanges = 0;
  let refreshes = 0;
  let validToken = 'fixture-token';
  let revoked = false;
  let stream;
  const received = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
    } else if (path.startsWith('/.well-known/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        issuer: origin, authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      }));
    } else if (path === '/register') {
      let body = '';
      for await (const chunk of req) body += chunk;
      metadata = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...metadata, client_id: 'fixture-client' }));
    } else if (path === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++;
        res.setHeader('Content-Type', 'application/json');
        if (revoked) { res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' })); return; }
        assert.equal(params.get('refresh_token'), 'fixture-refresh');
        res.end(JSON.stringify({ access_token: validToken, refresh_token: 'fixture-refresh', token_type: 'Bearer' }));
        return;
      }
      assert.equal(params.get('code'), 'fixture-code');
      assert.equal(params.get('redirect_uri'), metadata.redirect_uris[0]);
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),
        authorization.searchParams.get('code_challenge'));
      exchanges++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: validToken, refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 }));
    } else if (path === '/mcp' || path === '/messages') {
      received.push(req.headers.authorization);
      if (req.headers.authorization !== (header || `Bearer ${validToken}`)) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
        res.end();
        return;
      }
      if (req.method === 'GET') {
        if (type === 'http') { res.writeHead(405).end(); return; }
        stream = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'hello', inputSchema: { type: 'object' } }] };
      const response = { jsonrpc: '2.0', id: message.id, result };
      if (type === 'sse') {
        stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.writeHead(202).end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response));
      }
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    url: `${origin}/mcp`, received, exchanges: () => exchanges, refreshes: () => refreshes,
    expire() { validToken = 'renewed-token'; },
    revoke() { revoked = true; validToken = 'reauthenticated-token'; },
    async approve(href) {
      authorization = new URL(href);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', 'fixture-code');
      const result = await fetch(callback);
      assert.equal(result.status, 200);
    },
  };
}

for (const type of ['http', 'sse']) {
  test(`${type}: SDK discovery, registration, state/PKCE callback and authenticated handshake`, async (t) => {
    const server = await fixture(t, { type });
    let opened = 0;
    const { transport } = createMcpTransport({
      name: 'fixture', cfg: { type, url: server.url },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport }, log: () => {},
      oauthOptions: { openBrowser: async (url) => { opened++; await server.approve(url); } },
    });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => transport.close());
    const result = await runBoundedHandshake({
      name: 'fixture', cfg: {}, client, transport,
      closeServer: () => transport.close(),
    });
    assert.equal(result.toolsResult.tools[0].name, 'hello');
    assert.equal(opened, 1);
    assert.equal(server.exchanges(), 1);
    assert.equal(server.received[0], undefined);
    assert.ok(server.received.includes('Bearer fixture-token'));
  });

  test(`${type}: explicit bearer/header authentication does not start OAuth`, async (t) => {
    const server = await fixture(t, { type, header: 'Bearer existing' });
    const { transport } = createMcpTransport({
      name: 'fixture', cfg: { type, url: server.url, headers: { Authorization: 'Bearer existing' } },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport }, log: () => {},
      oauthOptions: { openBrowser: () => assert.fail('OAuth must not open') },
    });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => transport.close());
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name, 'hello');
    assert.equal(server.exchanges(), 0);
    assert.ok(server.received.every((value) => value === 'Bearer existing'));
  });
}

test('callback rejects missing/mismatched/duplicate state and wrong method/path before accepting the real callback', async (t) => {
  const server = await fixture(t);
  const oauth = createMcpOAuth({
    url: server.url,
    openBrowser: async (href) => {
      const authUrl = new URL(href);
      const callback = new URL(authUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'fixture-code');
      for (const state of ['', 'attacker']) {
        callback.searchParams.set('state', state);
        assert.equal((await fetch(callback)).status, 400);
      }
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      assert.equal((await fetch(callback, { method: 'POST' })).status, 400);
      callback.searchParams.append('state', 'attacker');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.delete('state');
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      callback.pathname = '/wrong';
      assert.equal((await fetch(callback)).status, 400);
      assert.equal(server.exchanges(), 0);
      await server.approve(href);
    },
  });
  t.after(() => oauth.close());
  const response = await oauth.fetch(server.url);
  assert.equal(response.status, 405);
  assert.equal(server.exchanges(), 1);
});

test('OAuth access tokens are never attached to another origin', async (t) => {
  const server = await fixture(t);
  const other = await fixture(t);
  const oauth = createMcpOAuth({ url: server.url, openBrowser: (href) => server.approve(href) });
  t.after(() => oauth.close());
  assert.equal((await oauth.fetch(server.url)).status, 405);
  const response = await oauth.fetch(other.url);
  assert.equal(response.status, 401);
  assert.deepEqual(other.received, [undefined]);
  assert.equal(other.exchanges(), 0);
});

for (const mode of ['cancel', 'request-abort', 'timeout', 'denial']) {
  test(`OAuth ${mode} rejects safely, performs no token exchange, and closes the callback listener`, async (t) => {
    const server = await fixture(t);
    let callback;
    const controller = new AbortController();
    const oauth = createMcpOAuth({
      url: server.url, timeoutMs: mode === 'timeout' ? 100 : 5000,
      openBrowser: async (href) => {
        const url = new URL(href);
        callback = new URL(url.searchParams.get('redirect_uri'));
        if (mode === 'cancel') oauth.close();
        if (mode === 'request-abort') controller.abort();
        if (mode === 'denial') {
          callback.searchParams.set('state', url.searchParams.get('state'));
          callback.searchParams.set('error', 'access_denied');
          await fetch(callback);
        }
      },
    });
    t.after(() => oauth.close());
    await assert.rejects(oauth.fetch(server.url, { signal: controller.signal }), /MCP OAuth login failed, cancelled, or timed out/);
    assert.ok(callback);
    assert.equal(server.exchanges(), 0);
    await assert.rejects(fetch(callback));
  });
}

for (const type of ['http', 'sse']) {
  test(`${type}: closing the transport cancels a challenged handshake and cleans the callback`, async (t) => {
    const server = await fixture(t, { type });
    let opened;
    const ready = new Promise((resolve) => { opened = resolve; });
    let callback;
    const { transport } = createMcpTransport({
      name: 'fixture', cfg: { type, url: server.url },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport }, log: () => {},
      oauthOptions: { openBrowser: (href) => {
        callback = new URL(href).searchParams.get('redirect_uri');
        opened();
      } },
    });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => transport.close());
    const handshake = runBoundedHandshake({
      name: 'fixture', cfg: {}, client, transport, closeServer: () => transport.close(),
    });
    const rejected = assert.rejects(handshake);
    await ready;
    await transport.close();
    await rejected;
    assert.equal(server.exchanges(), 0);
    await assert.rejects(fetch(callback));
  });
}

test('human login outlives the ordinary startup budget without timing out the SDK initialize request', async (t) => {
  const server = await fixture(t);
  const { transport } = createMcpTransport({
    name: 'fixture', cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport, SSEClientTransport }, log: () => {},
    oauthOptions: { openBrowser: async (href) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await server.approve(href);
    } },
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => transport.close());
  const result = await runBoundedHandshake({
    name: 'fixture', cfg: { startupTimeoutMs: 80 }, client, transport, closeServer: () => transport.close(),
  });
  assert.equal(result.toolsResult.tools[0].name, 'hello');
});

test('stored credentials survive connection close and a fresh store instance without reopening', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  const first = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
  assert.equal((await first.fetch(server.url)).status, 405);
  first.close();
  const saved = JSON.parse([...store.values.values()][0]);
  assert.equal(saved.clientInformation.client_id, 'fixture-client');
  assert.equal(saved.tokens.refresh_token, 'fixture-refresh');
  assert.match(saved.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  const restarted = buildOAuth({
    url: server.url, credentialStore: memoryStore(store.values),
    openBrowser: () => assert.fail('Stored credentials must not open a browser'),
  });
  t.after(() => restarted.close());
  assert.equal((await restarted.fetch(server.url)).status, 405);
  server.expire();
  assert.equal((await restarted.fetch(server.url)).status, 405);
  assert.equal(server.exchanges(), 1);
  assert.equal(server.refreshes(), 1);
});

test('background missing and revoked credentials require explicit reconnect without popup', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  const background = buildOAuth({ url: server.url, credentialStore: store,
    openBrowser: () => assert.fail('Background login is forbidden') });
  await assert.rejects(background.fetch(server.url), { code: 'reauthenticationRequired' });
  background.close();
  const login = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
  await login.fetch(server.url);
  login.close();
  server.revoke();
  const recovery = buildOAuth({ url: server.url, credentialStore: store,
    openBrowser: () => assert.fail('Automatic recovery must not open a browser') });
  await assert.rejects(recovery.fetch(server.url), { code: 'reauthenticationRequired' });
  await assert.rejects(recovery.fetch(server.url), { code: 'reauthenticationRequired' });
  recovery.close();
  let opened = 0;
  const reconnect = createMcpOAuth({ url: server.url, credentialStore: store,
    openBrowser: async (href) => { opened++; await server.approve(href); } });
  t.after(() => reconnect.close());
  assert.equal((await reconnect.fetch(server.url)).status, 405);
  assert.equal(opened, 1);
  assert.equal(server.exchanges(), 2);
});

test('concurrent connections share one login and cancelling one does not cancel the other', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  let authorize;
  let opened = 0;
  let notify;
  const ready = new Promise((resolve) => { notify = resolve; });
  const options = {
    url: server.url, credentialStore: store,
    openBrowser: (href) => { opened++; authorize = href; notify(); },
  };
  const first = createMcpOAuth(options);
  const second = createMcpOAuth(options);
  t.after(() => { first.close(); second.close(); });
  const a = first.fetch(server.url);
  const rejected = assert.rejects(a, /cancelled/);
  const b = second.fetch(server.url);
  await ready;
  first.close();
  await rejected;
  await server.approve(authorize);
  assert.equal((await b).status, 405);
  assert.equal(opened, 1);
  assert.equal(server.exchanges(), 1);
  server.expire();
  const third = buildOAuth({ ...options, openBrowser: () => assert.fail('Refresh must not open') });
  t.after(() => third.close());
  const refreshed = await Promise.all([second.fetch(server.url), third.fetch(server.url)]);
  assert.ok(refreshed.every((response) => response.status === 405));
  assert.equal(server.refreshes(), 1);
});

test('exact server paths and queries isolate credentials and token forwarding', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  const login = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
  t.after(() => login.close());
  await login.fetch(server.url);
  for (const url of [server.url + '?tenant=other', server.url.replace('/mcp', '/messages')]) {
    const isolated = buildOAuth({ url, credentialStore: store, openBrowser: () => assert.fail('No popup') });
    t.after(() => isolated.close());
    await assert.rejects(isolated.fetch(url), { code: 'reauthenticationRequired' });
    assert.equal((await login.fetch(url)).status, 401);
    assert.equal(server.received.at(-1), undefined);
  }
  assert.equal(server.exchanges(), 1);
});

test('successful handshake consumes explicit permission before later automatic recovery', async (t) => {
  const server = await fixture(t);
  let opened = 0;
  const { transport } = createMcpTransport({
    name: 'fixture', cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport }, log: () => {},
    oauthOptions: { openBrowser: async (url) => { opened++; await server.approve(url); } },
  });
  t.after(() => transport.close());
  await runBoundedHandshake({
    name: 'fixture', cfg: {}, client: new Client({ name: 'test', version: '1' }), transport,
    closeServer: () => transport.close(),
  });
  server.revoke();
  await assert.rejects(transport.oauth.fetch(server.url), { code: 'reauthenticationRequired' });
  assert.equal(opened, 1);
});
