import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createMcpTransport } from './client-transport.mjs';
import { createMcpOAuth } from './oauth.mjs';
import { runBoundedHandshake } from './client-handshake.mjs';

async function fixture(t, { type = 'http', header = null } = {}) {
  let origin;
  let metadata;
  let authorization;
  let exchanges = 0;
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
      assert.equal(params.get('code'), 'fixture-code');
      assert.equal(params.get('redirect_uri'), metadata.redirect_uris[0]);
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),
        authorization.searchParams.get('code_challenge'));
      exchanges++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }));
    } else if (path === '/mcp' || path === '/messages') {
      received.push(req.headers.authorization);
      if (req.headers.authorization !== (header || 'Bearer fixture-token')) {
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
    url: `${origin}/mcp`, received, exchanges: () => exchanges,
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
