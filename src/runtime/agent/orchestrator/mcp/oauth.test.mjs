import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { createMcpTransport as buildTransport } from './client-transport.mjs';
import {
  clearMcpOAuth,
  createMcpOAuth as buildOAuth,
  hasStoredMcpOAuthTokens,
  isMcpOAuthReauthenticationRequired,
  isMcpOAuthScopeNotGranted,
  commitMcpOAuthSwitch,
  MCP_OAUTH_CALLBACK_MAX_BYTES,
  mcpOAuthAccount,
  parsePastedMcpOAuthCallback,
  startMcpOAuthSwitch,
  storedMcpOAuthIdentity,
} from './oauth.mjs';
import { canForceAccountChoice, identityFromTokenResponse, withAccountParams } from './oauth-account.mjs';
import { mcpOAuthDisplayName } from './oauth-client.mjs';
import { createOAuthProvider } from './oauth-provider.mjs';
import { missingScopes } from './oauth-shared.mjs';
import { createMcpOAuthLogins } from '../../../../session-runtime/mcp-oauth-login.mjs';
import { OAUTH_PAGE_CONTENT_TYPE } from '../providers/lib/oauth-page.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { probeMcpServerAuth } from './oauth-probe.mjs';
import { runBoundedHandshake } from './client-handshake.mjs';
import { scrubMcpConnectionMessage } from './client-config.mjs';

function memoryStore(values = new Map()) {
  return {
    values,
    getSecretAsync: async (key) => values.get(key),
    setSecretAsync: async (key, value) => {
      values.set(key, value);
    },
    deleteSecretAsync: async (key) => {
      values.delete(key);
    },
  };
}
// The explicit sign-in tests drive the real client, whose OAuth store is the
// OS keychain. A runner without one (Linux CI has no Secret Service) fails
// every challenge as sign-in required, by design (see the unreadable-keychain
// test), so this file backs the keychain with memory.
{
  const { values: _values, ...store } = memoryStore();
  Object.assign(keychain, store);
}
// A credential store another process can share: one file per account. The
// second process below builds the same store from this source.
const FILE_STORE_SOURCE = `(dir) => ({
  getSecretAsync: (key) => readFile(join(dir, key + '.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }),
  setSecretAsync: (key, value) => writeFile(join(dir, key + '.json'), value),
  deleteSecretAsync: (key) => rm(join(dir, key + '.json'), { force: true }),
})`;
const fileStore = (dir) => ({
  getSecretAsync: (key) =>
    readFile(join(dir, `${key}.json`), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  setSecretAsync: (key, value) => writeFile(join(dir, `${key}.json`), value),
  deleteSecretAsync: (key) => rm(join(dir, `${key}.json`), { force: true }),
});
function storeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-mcp-oauth-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A real second process sharing the store directory and the credential lock files.
async function logOutInAnotherProcess(dir, url) {
  await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { readFile, rm, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { clearMcpOAuth } from ${JSON.stringify(new URL('./oauth.mjs', import.meta.url).href)};
    const [dir, url] = process.argv.slice(1);
    await clearMcpOAuth({ url, credentialStore: (${FILE_STORE_SOURCE})(dir) });
  `,
    dir,
    url,
  ]);
}
// Holds the next request sent with one bearer token until released.
function holdingFetch() {
  let token;
  let onHeld;
  let release;
  return {
    async fetchImpl(input, init = {}) {
      if (token && new Headers(init.headers).get('authorization') === `Bearer ${token}`) {
        token = undefined;
        await new Promise((resolve) => {
          release = resolve;
          onHeld();
        });
      }
      return fetch(input, init);
    },
    hold(value) {
      token = value;
      return new Promise((resolve) => {
        onHeld = resolve;
      });
    },
    release: () => release(),
  };
}
const createMcpOAuth = (options) => buildOAuth({ credentialStore: memoryStore(), interactive: true, ...options });
const createMcpTransport = (options) =>
  buildTransport({
    ...options,
    oauthOptions: { credentialStore: memoryStore(), interactive: true, ...options.oauthOptions },
  });

async function fixture(
  t,
  { type = 'http', header = null, rotate = false, failTools = false, resetRetry = false } = {}
) {
  let origin;
  let metadata;
  let authorization;
  let exchanges = 0;
  let refreshes = 0;
  let lastPage;
  let validToken = 'fixture-token';
  let refreshToken = 'fixture-refresh';
  let revoked = false;
  let stream;
  // Registered client ids; a restart forgets them (and every token).
  const clients = new Set();
  let registrations = 0;
  let clientError = 'invalid_client';
  const assertKnownClient = (href) => {
    // The authorization endpoint refuses an unknown client (HTTP 400).
    if (!clients.has(new URL(href).searchParams.get('client_id'))) throw new Error('authorize: unknown client');
  };
  const received = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
    } else if (path.startsWith('/.well-known/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      );
    } else if (path === '/register') {
      let body = '';
      for await (const chunk of req) body += chunk;
      metadata = JSON.parse(body);
      registrations++;
      const clientId = registrations === 1 ? 'fixture-client' : `fixture-client-${registrations}`;
      clients.add(clientId);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...metadata, client_id: clientId }));
    } else if (path === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') refreshes++;
      if (!clients.has(params.get('client_id'))) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: clientError }));
        return;
      }
      if (params.get('grant_type') === 'refresh_token') {
        res.setHeader('Content-Type', 'application/json');
        // A rotated refresh token is single-use, as with real issuers.
        if (revoked || params.get('refresh_token') !== refreshToken) {
          res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (rotate) refreshToken = `fixture-refresh-${refreshes}`;
        res.end(JSON.stringify({ access_token: validToken, refresh_token: refreshToken, token_type: 'Bearer' }));
        return;
      }
      assert.equal(params.get('code'), 'fixture-code');
      assert.equal(params.get('redirect_uri'), metadata.redirect_uris[0]);
      assert.equal(
        createHash('sha256').update(params.get('code_verifier')).digest('base64url'),
        authorization.searchParams.get('code_challenge')
      );
      exchanges++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          access_token: validToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 3600,
        })
      );
    } else if (path === '/mcp' || path === '/messages') {
      received.push(req.headers.authorization);
      if (req.headers.authorization !== (header || `Bearer ${validToken}`)) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
        res.end();
        return;
      }
      if (resetRetry) {
        // The first authenticated request (the retry after the login) dies.
        resetRetry = false;
        req.socket.destroy();
        return;
      }
      if (req.method === 'GET') {
        if (type === 'http') {
          res.writeHead(405).end();
          return;
        }
        stream = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (failTools && message.method === 'tools/list') {
        res.writeHead(500).end('tools unavailable');
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
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
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `${origin}/mcp`,
    received,
    exchanges: () => exchanges,
    refreshes: () => refreshes,
    registrations: () => registrations,
    /** The authorization server restarts: every client registration and token
     *  is forgotten; the token endpoint answers `error` for an unknown client. */
    restart({ error = 'invalid_client' } = {}) {
      clients.clear();
      clientError = error;
      refreshToken = 'fixture-refresh-restarted';
      validToken = 'restarted-token';
    },
    expire(next = 'renewed-token') {
      validToken = next;
    },
    revoke() {
      revoked = true;
      validToken = 'reauthenticated-token';
    },
    /** The redirect URL the browser would land on for `href`, as a user pastes it. */
    callbackFor(href, params = { code: 'fixture-code' }) {
      assertKnownClient(href);
      authorization = new URL(href);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
      return callback.href;
    },
    async approve(href) {
      assertKnownClient(href);
      authorization = new URL(href);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', 'fixture-code');
      // The callback page answers only after the code exchange, which starts
      // once this browser step returns: never wait for it here (`page()`).
      lastPage = fetch(callback);
      lastPage.catch(() => {});
    },
    /** The callback page of the last `approve`. */
    page: () => lastPage,
  };
}

for (const type of ['http', 'sse']) {
  test(`${type}: SDK discovery, registration, state/PKCE callback and authenticated handshake`, async (t) => {
    const server = await fixture(t, { type });
    let opened = 0;
    const { transport } = createMcpTransport({
      name: 'fixture',
      cfg: { type, url: server.url },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport },
      log: () => {},
      oauthOptions: {
        openBrowser: async (url) => {
          opened++;
          await server.approve(url);
        },
      },
    });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => transport.close());
    const result = await runBoundedHandshake({
      name: 'fixture',
      cfg: {},
      client,
      transport,
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
      name: 'fixture',
      cfg: { type, url: server.url, headers: { Authorization: 'Bearer existing' } },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport },
      log: () => {},
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
      const invalid = await fetch(callback);
      assert.equal(invalid.status, 400);
      assertCallbackPage(invalid);
      assert.match(await invalid.text(), /로그인 실패[\s\S]*Sign-in failed/);
      assert.equal(server.exchanges(), 0);
      await server.approve(href);
    },
  });
  t.after(() => oauth.close());
  const response = await oauth.fetch(server.url);
  assert.equal(response.status, 405);
  assert.equal(server.exchanges(), 1);
});

function assertCallbackPage(response) {
  assert.equal(response.headers.get('content-type'), OAUTH_PAGE_CONTENT_TYPE);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

test('callback pages: success names the MCP server; a denied sign-in gets the error page without reflecting it', async (t) => {
  const server = await fixture(t);
  const { transport } = createMcpTransport({
    name: 'Fixture <Docs>',
    cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport, SSEClientTransport },
    log: () => {},
    oauthOptions: {
      openBrowser: async (href) => {
        assert.equal(transport.oauth.loginStarted, true);
        assert.equal(transport.oauth.loginCompleted, false);
        await server.approve(href);
      },
    },
  });
  t.after(() => transport.close());
  assert.equal(transport.oauth.loginStarted, false);
  assert.equal((await transport.oauth.fetch(server.url)).status, 405);
  assert.equal(transport.oauth.loginCompleted, true);
  const page = await server.page();
  assert.equal(page.status, 200);
  assertCallbackPage(page);
  const html = await page.text();
  assert.match(html, /로그인 완료/);
  assert.match(html, /Fixture &lt;Docs&gt; 로그인이 완료되었습니다\./);
  assert.match(html, /signed in to Fixture &lt;Docs&gt;\. You can close this tab/);

  const denied = await fixture(t);
  let deniedPage;
  const oauth = createMcpOAuth({
    url: denied.url,
    serverName: 'Denied',
    openBrowser: async (href) => {
      const authorization = new URL(href);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('error', 'access_denied');
      callback.searchParams.set('error_description', '<script>reflected</script>');
      deniedPage = await fetch(callback);
    },
  });
  t.after(() => oauth.close());
  await assert.rejects(oauth.fetch(denied.url), /MCP OAuth login failed, cancelled, or timed out/);
  assert.equal(oauth.loginCompleted, false);
  assert.equal(deniedPage.status, 400);
  assertCallbackPage(deniedPage);
  const deniedHtml = await deniedPage.text();
  assert.match(deniedHtml, /Sign-in to Denied was not completed\./);
  assert.doesNotMatch(deniedHtml, /reflected|access_denied/);
  assert.equal(denied.exchanges(), 0);
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
      // The timeout must outlast discovery, registration and the credential
      // lock/marker writes before the browser step, even under suite load.
      url: server.url,
      timeoutMs: mode === 'timeout' ? 1000 : 5000,
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
    await assert.rejects(
      oauth.fetch(server.url, { signal: controller.signal }),
      /MCP OAuth login failed, cancelled, or timed out/
    );
    assert.ok(callback);
    assert.equal(server.exchanges(), 0);
    await assert.rejects(fetch(callback));
  });
}

for (const type of ['http', 'sse']) {
  test(`${type}: closing the transport cancels a challenged handshake and cleans the callback`, async (t) => {
    const server = await fixture(t, { type });
    let opened;
    const ready = new Promise((resolve) => {
      opened = resolve;
    });
    let callback;
    const { transport } = createMcpTransport({
      name: 'fixture',
      cfg: { type, url: server.url },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport },
      log: () => {},
      oauthOptions: {
        openBrowser: (href) => {
          callback = new URL(href).searchParams.get('redirect_uri');
          opened();
        },
      },
    });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => transport.close());
    const handshake = runBoundedHandshake({
      name: 'fixture',
      cfg: {},
      client,
      transport,
      closeServer: () => transport.close(),
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
    name: 'fixture',
    cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport, SSEClientTransport },
    log: () => {},
    oauthOptions: {
      openBrowser: async (href) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await server.approve(href);
      },
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => transport.close());
  const result = await runBoundedHandshake({
    name: 'fixture',
    cfg: { startupTimeoutMs: 80 },
    client,
    transport,
    closeServer: () => transport.close(),
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
    url: server.url,
    credentialStore: memoryStore(store.values),
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
  const background = buildOAuth({
    url: server.url,
    credentialStore: store,
    openBrowser: () => assert.fail('Background login is forbidden'),
  });
  await assert.rejects(background.fetch(server.url), { code: 'reauthenticationRequired' });
  background.close();
  const login = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
  await login.fetch(server.url);
  login.close();
  server.revoke();
  const recovery = buildOAuth({
    url: server.url,
    credentialStore: store,
    openBrowser: () => assert.fail('Automatic recovery must not open a browser'),
  });
  await assert.rejects(recovery.fetch(server.url), { code: 'reauthenticationRequired' });
  await assert.rejects(recovery.fetch(server.url), { code: 'reauthenticationRequired' });
  recovery.close();
  let opened = 0;
  const reconnect = createMcpOAuth({
    url: server.url,
    credentialStore: store,
    openBrowser: async (href) => {
      opened++;
      await server.approve(href);
    },
  });
  t.after(() => reconnect.close());
  assert.equal((await reconnect.fetch(server.url)).status, 405);
  assert.equal(opened, 1);
  assert.equal(server.exchanges(), 2);
});

for (const error of ['invalid_client', 'unauthorized_client', 'invalid_grant']) {
  test(`a client registration the authorization server forgot (${error} on refresh) is dropped; the next sign-in re-registers`, async (t) => {
    const server = await fixture(t);
    const store = memoryStore();
    const account = mcpOAuthAccount(server.url);
    const login = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
    assert.equal((await login.fetch(server.url)).status, 405);
    login.close();
    assert.equal(JSON.parse(store.values.get(account)).clientInformation.client_id, 'fixture-client');
    server.restart({ error });
    const background = buildOAuth({
      url: server.url,
      credentialStore: store,
      openBrowser: () => assert.fail('Automatic recovery must not open a browser'),
    });
    await assert.rejects(background.fetch(server.url), { code: 'reauthenticationRequired' });
    background.close();
    assert.equal(server.refreshes(), 1);
    // The background connect registers nothing; neither the rejected tokens
    // nor the forgotten registration survive.
    assert.equal(server.registrations(), 1);
    const left = store.values.get(account);
    assert.equal(left ? JSON.parse(left).clientInformation?.client_id : undefined, undefined);
    assert.equal(left ? JSON.parse(left).tokens : undefined, undefined);
    assert.equal(hasStoredMcpOAuthTokens(server.url), false);
    const reconnect = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
    t.after(() => reconnect.close());
    assert.equal((await reconnect.fetch(server.url)).status, 405);
    assert.equal(server.registrations(), 2);
    assert.equal(server.exchanges(), 2);
    assert.equal(JSON.parse(store.values.get(account)).clientInformation.client_id, 'fixture-client-2');
    assert.equal(hasStoredMcpOAuthTokens(server.url), true);
  });
}

test('concurrent connections share one login and cancelling one does not cancel the other', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  let authorize;
  let opened = 0;
  let notify;
  const ready = new Promise((resolve) => {
    notify = resolve;
  });
  const options = {
    url: server.url,
    credentialStore: store,
    openBrowser: (href) => {
      opened++;
      authorize = href;
      notify();
    },
  };
  const first = createMcpOAuth(options);
  const second = createMcpOAuth(options);
  t.after(() => {
    first.close();
    second.close();
  });
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
  for (const url of [`${server.url}?tenant=other`, server.url.replace('/mcp', '/messages')]) {
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
    name: 'fixture',
    cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport },
    log: () => {},
    oauthOptions: {
      openBrowser: async (url) => {
        opened++;
        await server.approve(url);
      },
    },
  });
  t.after(() => transport.close());
  await runBoundedHandshake({
    name: 'fixture',
    cfg: {},
    client: new Client({ name: 'test', version: '1' }),
    transport,
    closeServer: () => transport.close(),
  });
  server.revoke();
  await assert.rejects(transport.oauth.fetch(server.url), { code: 'reauthenticationRequired' });
  assert.equal(opened, 1);
});

test('keychain account names are stable per exact URL and valid file names', (t) => {
  const url = 'https://mcp.example/mcp?tenant=a';
  const account = mcpOAuthAccount(url);
  assert.equal(account, mcpOAuthAccount(url));
  assert.notEqual(account, mcpOAuthAccount('https://mcp.example/mcp?tenant=b'));
  assert.match(account, /^[A-Za-z0-9._-]+$/);
  // The Windows keychain backend renames a temporary file onto `<account>.dpapi`.
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-mcp-account-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'secret.tmp'), 'ciphertext');
  renameSync(join(dir, 'secret.tmp'), join(dir, `${account}.dpapi`));
});

for (const auth of [
  { bearer_token_env_var: 'MIXDOG_TEST_UNSET_MCP_BEARER' },
  { env_http_headers: { 'X-Api-Key': 'MIXDOG_TEST_UNSET_MCP_KEY' } },
  { headers: { 'X-Api-Key': '${MIXDOG_TEST_UNSET_MCP_KEY}' } },
]) {
  test(`configured but unset ${Object.keys(auth)[0]} stays authoritative and never starts OAuth`, async (t) => {
    delete process.env.MIXDOG_TEST_UNSET_MCP_BEARER;
    delete process.env.MIXDOG_TEST_UNSET_MCP_KEY;
    const server = await fixture(t);
    const { transport } = createMcpTransport({
      name: 'fixture',
      cfg: { type: 'http', url: server.url, ...auth },
      sdk: { StreamableHTTPClientTransport },
      log: () => {},
      oauthOptions: { openBrowser: () => assert.fail('OAuth must not open') },
    });
    t.after(() => transport.close());
    assert.equal(transport.oauth, undefined);
    await assert.rejects(new Client({ name: 'test', version: '1' }).connect(transport));
    assert.ok(server.received.length > 0);
    assert.ok(server.received.every((value) => value === undefined));
    assert.equal(server.exchanges(), 0);
  });
}

test('an unreadable keychain blocks only servers that challenge for authentication', async (t) => {
  const open = createServer((_req, res) => res.writeHead(200).end('open'));
  await new Promise((resolve) => open.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    open.closeAllConnections();
    open.close();
  });
  const locked = {
    getSecretAsync: async () => {
      throw new Error('keychain locked');
    },
    setSecretAsync: async () => assert.fail('Nothing may be written'),
    deleteSecretAsync: async () => assert.fail('Nothing may be deleted'),
  };
  const openUrl = `http://127.0.0.1:${open.address().port}/mcp`;
  const anonymous = createMcpOAuth({
    url: openUrl,
    credentialStore: locked,
    openBrowser: () => assert.fail('No popup'),
  });
  t.after(() => anonymous.close());
  assert.equal((await anonymous.fetch(openUrl)).status, 200);
  const server = await fixture(t);
  const challenged = createMcpOAuth({
    url: server.url,
    credentialStore: locked,
    openBrowser: () => assert.fail('No popup'),
  });
  t.after(() => challenged.close());
  await assert.rejects(challenged.fetch(server.url), { code: 'reauthenticationRequired' });
  assert.deepEqual(server.received, [undefined]);
  assert.equal(server.exchanges(), 0);
});

test('clearing credentials deletes the keychain entry and logs live connections out', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  const live = createMcpOAuth({ url: server.url, credentialStore: store, openBrowser: server.approve });
  t.after(() => live.close());
  assert.equal((await live.fetch(server.url)).status, 405);
  live.finishConnect();
  assert.deepEqual([...store.values.keys()], [mcpOAuthAccount(server.url)]);
  assert.deepEqual(live.secrets(), ['fixture-token', 'fixture-refresh']);
  assert.equal(
    scrubMcpConnectionMessage('HTTP 500: echoed Bearer fixture-token (fixture-refresh)', {}, live.secrets()),
    'HTTP 500: echoed Bearer [redacted] ([redacted])'
  );
  await clearMcpOAuth({ url: server.url, credentialStore: store });
  assert.equal(store.values.size, 0);
  // A late response may still echo a token a request was sent with.
  assert.deepEqual(live.secrets(), ['fixture-token', 'fixture-refresh']);
  await assert.rejects(live.fetch(server.url), { code: 'reauthenticationRequired' });
  assert.equal(server.received.at(-1), undefined);
  await clearMcpOAuth({ url: server.url, credentialStore: store });
});

test('a refresh by another process is adopted instead of replaying its rotated refresh token', async (t) => {
  const server = await fixture(t, { rotate: true });
  const values = new Map();
  const login = createMcpOAuth({ url: server.url, credentialStore: memoryStore(values), openBrowser: server.approve });
  await login.fetch(server.url);
  login.close();
  // Separate stores over one keychain: separate in-memory state, as in two processes.
  const options = { url: server.url, openBrowser: () => assert.fail('Refresh must not open') };
  const first = buildOAuth({ ...options, credentialStore: memoryStore(values) });
  const second = buildOAuth({ ...options, credentialStore: memoryStore(values) });
  t.after(() => {
    first.close();
    second.close();
  });
  assert.equal((await first.fetch(server.url)).status, 405);
  assert.equal((await second.fetch(server.url)).status, 405);
  server.expire();
  const responses = await Promise.all([first.fetch(server.url), second.fetch(server.url)]);
  assert.ok(responses.every((response) => response.status === 405));
  assert.equal(server.refreshes(), 1);
  assert.equal(JSON.parse(values.get(mcpOAuthAccount(server.url))).tokens.refresh_token, 'fixture-refresh-1');
});

test('a delayed rejected retry never clears tokens another process refreshed since', async (t) => {
  const server = await fixture(t, { rotate: true });
  const values = new Map();
  const holding = holdingFetch();
  const first = createMcpOAuth({
    url: server.url,
    credentialStore: memoryStore(values),
    openBrowser: server.approve,
    fetchImpl: holding.fetchImpl,
  });
  t.after(() => first.close());
  assert.equal((await first.fetch(server.url)).status, 405);
  first.finishConnect();
  server.expire();
  // First refreshes (R0 -> R1); its retry with the refreshed token is delayed.
  const held = holding.hold('renewed-token');
  const delayed = first.fetch(server.url);
  await held;
  const second = buildOAuth({
    url: server.url,
    credentialStore: memoryStore(values),
    openBrowser: () => assert.fail('Refresh must not open'),
  });
  t.after(() => second.close());
  assert.equal((await second.fetch(server.url)).status, 405);
  // Second refreshes again (R1 -> R2) before the delayed retry arrives.
  server.expire('second-token');
  assert.equal((await second.fetch(server.url)).status, 405);
  holding.release();
  await assert.rejects(delayed, { code: 'reauthenticationRequired' });
  const stored = JSON.parse(values.get(mcpOAuthAccount(server.url)));
  assert.equal(stored.tokens.refresh_token, 'fixture-refresh-2');
  assert.equal(stored.tokens.access_token, 'second-token');
  assert.equal((await first.fetch(server.url)).status, 405);
  assert.equal((await second.fetch(server.url)).status, 405);
  assert.equal(server.refreshes(), 2);
  // Tokens rotated away stay known for scrubbing late echoes.
  for (const token of ['fixture-token', 'renewed-token', 'second-token', 'fixture-refresh-1']) {
    assert.ok(first.secrets().includes(token), token);
  }
});

test('a log-out by another process wins over a login pending since before it', async (t) => {
  const server = await fixture(t);
  const dir = storeDir(t);
  let opened;
  const authorization = new Promise((resolve) => {
    opened = resolve;
  });
  const pending = createMcpOAuth({
    url: server.url,
    credentialStore: fileStore(dir),
    openBrowser: (href) => opened(href),
  });
  t.after(() => pending.close());
  const login = pending.fetch(server.url);
  const rejected = assert.rejects(login, /MCP OAuth login failed, cancelled, or timed out/);
  const href = await authorization;
  await logOutInAnotherProcess(dir, server.url);
  assert.deepEqual(readdirSync(dir), []);
  await server.approve(href);
  await rejected;
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(server.exchanges(), 0);
});

test('cached tokens observe a log-out by another process and never restore its credentials', async (t) => {
  const server = await fixture(t);
  const dir = storeDir(t);
  const holding = holdingFetch();
  const cached = createMcpOAuth({
    url: server.url,
    credentialStore: fileStore(dir),
    openBrowser: server.approve,
    fetchImpl: holding.fetchImpl,
  });
  t.after(() => cached.close());
  assert.equal((await cached.fetch(server.url)).status, 405);
  cached.finishConnect();
  server.expire();
  // Refreshed; the retry with the refreshed token is sent after the log-out and rejected.
  const held = holding.hold('renewed-token');
  const request = cached.fetch(server.url);
  await held;
  await logOutInAnotherProcess(dir, server.url);
  server.expire('after-logout-token');
  holding.release();
  await assert.rejects(request, { code: 'reauthenticationRequired' });
  assert.deepEqual(readdirSync(dir), []);
  // The cached refresh token is not used after the log-out either.
  await assert.rejects(cached.fetch(server.url), { code: 'reauthenticationRequired' });
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(server.refreshes(), 1);
  assert.equal(server.received.at(-1), undefined);
});

test('the next request after a log-out by another process carries no cached token', async (t) => {
  const server = await fixture(t);
  const dir = storeDir(t);
  const cached = createMcpOAuth({ url: server.url, credentialStore: fileStore(dir), openBrowser: server.approve });
  t.after(() => cached.close());
  assert.equal((await cached.fetch(server.url)).status, 405);
  cached.finishConnect();
  assert.equal((await cached.fetch(server.url)).status, 405);
  const sent = server.received.length;
  // The server keeps accepting the token: no 401 tells this process.
  await logOutInAnotherProcess(dir, server.url);
  await assert.rejects(cached.fetch(server.url), { code: 'reauthenticationRequired' });
  assert.deepEqual(server.received.slice(sent), [undefined]);
  assert.equal(server.refreshes(), 0);
  assert.deepEqual(readdirSync(dir), []);
});

// A port nothing listens on: bound once, then released.
async function refusedUrl() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

for (const type of ['http', 'sse']) {
  test(`${type}: a refused connection without configured auth reports the connection error, not a login`, async (t) => {
    const url = await refusedUrl();
    const { transport } = buildTransport({
      name: 'refused',
      cfg: { type, url },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport },
      log: () => {},
      oauthOptions: { credentialStore: memoryStore(), openBrowser: () => assert.fail('No login') },
    });
    t.after(() => transport.close());
    await assert.rejects(
      runBoundedHandshake({
        name: 'refused',
        cfg: {},
        client: new Client({ name: 'test', version: '1' }),
        transport,
        closeServer: () => transport.close(),
      }),
      (error) => {
        assert.doesNotMatch(error.message, /OAuth|cancelled/);
        assert.match(String(error.message), /fetch failed|ECONNREFUSED|SSE error/);
        return true;
      }
    );
  });

  test(`${type}: a non-interactive connect to a challenging server needs a sign-in and opens nothing`, async (t) => {
    const server = await fixture(t, { type });
    const { transport } = buildTransport({
      name: 'fixture',
      cfg: { type, url: server.url },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport },
      log: () => {},
      oauthOptions: { credentialStore: memoryStore(), openBrowser: () => assert.fail('No login') },
    });
    t.after(() => transport.close());
    await assert.rejects(
      runBoundedHandshake({
        name: 'fixture',
        cfg: {},
        client: new Client({ name: 'test', version: '1' }),
        transport,
        closeServer: () => transport.close(),
      }),
      (error) => isMcpOAuthReauthenticationRequired(error)
    );
    assert.equal(server.exchanges(), 0);
  });
}

test('cancelling a started login rejects the handshake as a cancelled login and closes the listener', async (t) => {
  const server = await fixture(t);
  let callback;
  let opened;
  const ready = new Promise((resolve) => {
    opened = resolve;
  });
  const { transport } = createMcpTransport({
    name: 'fixture',
    cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport, SSEClientTransport },
    log: () => {},
    oauthOptions: {
      openBrowser: (href) => {
        callback = new URL(href).searchParams.get('redirect_uri');
        opened();
      },
    },
  });
  t.after(() => transport.close());
  const handshake = runBoundedHandshake({
    name: 'fixture',
    cfg: {},
    client: new Client({ name: 'test', version: '1' }),
    transport,
    closeServer: () => transport.close(),
  });
  const rejected = assert.rejects(handshake, /MCP OAuth login failed, cancelled, or timed out/);
  await ready;
  transport.oauth.close();
  await rejected;
  assert.equal(server.exchanges(), 0);
  await assert.rejects(fetch(callback));
});

test('a cancelled or denied explicit sign-in fails the connect as authRequired; a post-sign-in or refused failure does not', async (t) => {
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  const { cancelMcpLogin, reconnectSingleMcpServer } = await import('./client.mjs');
  const scopeId = 'oauth-sign-in-incomplete';
  for (const mode of ['cancel', 'denial']) {
    const server = await fixture(t);
    t.after(() => clearMcpOAuth({ url: server.url }));
    const connect = reconnectSingleMcpServer(
      scopeId,
      mode,
      { type: 'http', url: server.url },
      {
        interactive: true,
        openBrowser: async (href) => {
          if (mode === 'cancel') {
            setImmediate(() => cancelMcpLogin(mode, { scopeId }));
            return;
          }
          const authorization = new URL(href);
          const callback = new URL(authorization.searchParams.get('redirect_uri'));
          callback.searchParams.set('state', authorization.searchParams.get('state'));
          callback.searchParams.set('error', 'access_denied');
          assert.equal((await fetch(callback)).status, 400);
        },
      }
    );
    await assert.rejects(connect, (error) => {
      assert.match(error.message, /MCP OAuth login failed, cancelled, or timed out/);
      return error.authRequired === true;
    });
    assert.equal(server.exchanges(), 0);
  }
  // The sign-in completed (tokens exchanged); the server then fails listTools:
  // a real failure, not sign-in required.
  const broken = await fixture(t, { failTools: true });
  t.after(() => clearMcpOAuth({ url: broken.url }));
  await assert.rejects(
    reconnectSingleMcpServer(
      scopeId,
      'broken',
      { type: 'http', url: broken.url },
      { interactive: true, openBrowser: (href) => broken.approve(href) }
    ),
    (error) => {
      assert.doesNotMatch(error.message, /OAuth/);
      return error.authRequired === undefined;
    }
  );
  assert.equal(broken.exchanges(), 1);
  // Boundary: the exchange stored tokens, then the authenticated retry itself
  // fails on the network. The sign-in completed; the network error is real.
  const reset = await fixture(t, { resetRetry: true });
  t.after(() => clearMcpOAuth({ url: reset.url }));
  await assert.rejects(
    reconnectSingleMcpServer(
      scopeId,
      'reset',
      { type: 'http', url: reset.url },
      { interactive: true, openBrowser: (href) => reset.approve(href) }
    ),
    (error) => {
      assert.doesNotMatch(error.message, /OAuth/);
      return error.authRequired === undefined;
    }
  );
  assert.equal(reset.exchanges(), 1);
  assert.equal(hasStoredMcpOAuthTokens(reset.url), true);
  await assert.rejects(
    reconnectSingleMcpServer(scopeId, 'refused', { type: 'http', url: await refusedUrl() }, { interactive: true }),
    (error) => {
      assert.doesNotMatch(error.message, /OAuth/);
      return error.authRequired === undefined;
    }
  );
});

test('stored tokens (not a bare client registration) are visible through the non-secret marker until a log-out', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  let midLogin;
  const oauth = createMcpOAuth({
    url: server.url,
    credentialStore: store,
    openBrowser: async (href) => {
      // The client registration is stored by now; no tokens yet.
      midLogin = hasStoredMcpOAuthTokens(server.url);
      await server.approve(href);
    },
  });
  t.after(() => oauth.close());
  assert.equal(hasStoredMcpOAuthTokens(server.url), false);
  assert.equal((await oauth.fetch(server.url)).status, 405);
  assert.equal(store.values.size, 1);
  assert.equal(midLogin, false);
  assert.equal(hasStoredMcpOAuthTokens(server.url), true);

  // A marker written before the tokens flag existed is repaired by the next
  // request (one keychain read), never reported signed in meanwhile.
  const marker = join(resolvePluginData(), 'mcp-oauth', `${mcpOAuthAccount(server.url)}.rev`);
  const revision = JSON.parse([...store.values.values()][0]).revision;
  writeFileSync(marker, revision);
  assert.equal(hasStoredMcpOAuthTokens(server.url), false);
  assert.equal((await oauth.fetch(server.url)).status, 405);
  assert.equal(hasStoredMcpOAuthTokens(server.url), true);

  // Rejected tokens are forgotten: the registration alone remains.
  server.revoke();
  const quiet = buildOAuth({ url: server.url, credentialStore: store });
  t.after(() => quiet.close());
  await assert.rejects(quiet.fetch(server.url), { code: 'reauthenticationRequired' });
  // A non-interactive connection never starts a browser login.
  assert.equal(quiet.loginStarted, false);
  assert.equal(store.values.size, 1);
  assert.equal(hasStoredMcpOAuthTokens(server.url), false);

  await clearMcpOAuth({ url: server.url, credentialStore: store });
  assert.equal(hasStoredMcpOAuthTokens(server.url), false);
});

test('auth probe: OAuth discovery, plain servers, configured auth and unreachable servers', async (t) => {
  for (const type of ['http', 'sse']) {
    const server = await fixture(t, { type });
    assert.deepEqual(await probeMcpServerAuth({ type, url: server.url }), { auth: 'oauth' });
    // Nothing but the anonymous probe and discovery: no token, no login.
    assert.deepEqual(server.received, [undefined]);
    assert.equal(server.exchanges(), 0);
  }
  const configured = await fixture(t, { header: 'Bearer existing' });
  for (const auth of [
    { headers: { Authorization: 'Bearer existing' } },
    { bearer_token_env_var: 'MIXDOG_TEST_UNSET_TOKEN' },
    { env_http_headers: { 'X-Key': 'MIXDOG_TEST_UNSET_KEY' } },
  ]) {
    assert.deepEqual(await probeMcpServerAuth({ type: 'http', url: configured.url, ...auth }), {
      auth: 'configured',
    });
  }
  assert.deepEqual(configured.received, []);
  const plain = createServer((req, res) => {
    if (req.url.includes('/.well-known/')) res.writeHead(404).end();
    else if (req.url === '/locked') res.writeHead(401).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  const origin = `http://127.0.0.1:${plain.address().port}`;
  assert.deepEqual(await probeMcpServerAuth({ type: 'http', url: `${origin}/mcp` }), { auth: 'none' });
  const locked = await probeMcpServerAuth({ type: 'http', url: `${origin}/locked` });
  assert.equal(locked.auth, 'none');
  assert.match(locked.error, /HTTP 401/);
  const refused = await probeMcpServerAuth({ type: 'http', url: await refusedUrl() });
  assert.equal(refused.auth, 'unreachable');
  assert.ok(refused.error);
  const hung = createServer(() => {});
  await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    hung.closeAllConnections();
    hung.close();
  });
  const slow = await probeMcpServerAuth(
    { type: 'http', url: `http://127.0.0.1:${hung.address().port}/mcp` },
    { timeoutMs: 100 }
  );
  assert.deepEqual(slow, { auth: 'unreachable', error: 'no answer within 100ms' });
  await assert.rejects(probeMcpServerAuth({ command: 'node' }), /http or sse/);
});

test("a pasted callback must be exactly the pending login's redirect; every refusal is a fixed message", () => {
  const redirectUrl = 'http://127.0.0.1:4567/oauth/callback';
  const state = 'pending-state-value';
  const parse = (pasted, redirect = redirectUrl) =>
    parsePastedMcpOAuthCallback(pasted, { redirectUrl: redirect, state });
  const ok = `${redirectUrl}?code=the-code&state=${state}`;
  assert.deepEqual(parse(ok), { code: 'the-code' });
  assert.deepEqual(parse(`  ${ok}&iss=https%3A%2F%2Fauth.example\n`), { code: 'the-code' });
  assert.deepEqual(parse(`${redirectUrl}?error=access_denied&error_description=secret-reason&state=${state}`), {
    denied: true,
  });
  // Parameters a server adds beyond the OAuth reply (Google) are ignored.
  assert.deepEqual(parse(`${ok}&scope=openid%20email&authuser=0&prompt=consent`), { code: 'the-code' });
  const rejected = {
    'not a string': 42,
    'over 64 KiB': `${ok}&iss=${'a'.repeat(MCP_OAUTH_CALLBACK_MAX_BYTES)}`,
    'not a URL': 'code=the-code secret-paste',
    fragment: `${ok}#secret-fragment`,
    'empty fragment': `${ok}#`,
    username: ok.replace('http://', 'http://secret-user@'),
    password: ok.replace('http://', 'http://u:secret-pass@'),
    'other host': ok.replace('127.0.0.1', 'localhost'),
    'other port': ok.replace(':4567', ':4568'),
    'other scheme': ok.replace('http://', 'https://'),
    'other path': ok.replace('/oauth/callback', '/oauth/callback2'),
    'duplicate extra param': `${ok}&scope=a&scope=secret-b`,
    'duplicate code': `${ok}&code=other`,
    'duplicate state': `${ok}&state=${state}`,
    'missing state': `${redirectUrl}?code=the-code`,
    'wrong state': `${redirectUrl}?code=the-code&state=pending-state-valuX`,
    'shorter state': `${redirectUrl}?code=the-code&state=pending`,
    'code and error': `${ok}&error=access_denied`,
    'neither code nor error': `${redirectUrl}?state=${state}`,
    'empty code': `${redirectUrl}?code=&state=${state}`,
  };
  for (const [rule, pasted] of Object.entries(rejected)) {
    assert.throws(
      () => parse(pasted),
      (error) => {
        assert.match(error.message, /pasted sign-in URL is invalid/, rule);
        assert.doesNotMatch(error.message, /secret|the-code|pending-state|access_denied/, rule);
        return true;
      },
      rule
    );
  }
  // The redirect URI's own query parameters must come back verbatim.
  const own = `${redirectUrl}?client=mixdog`;
  assert.deepEqual(parse(`${own}&code=c&state=${state}`, own), { code: 'c' });
  assert.deepEqual(parse(`${own}&code=c&state=${state}&hd=example.com`, own), { code: 'c' });
  for (const pasted of [
    `${redirectUrl}?code=c&state=${state}`,
    `${redirectUrl}?client=other&code=c&state=${state}`,
    `${own}&client=mixdog&code=c&state=${state}`,
    `${own}&client=other&code=c&state=${state}`,
  ]) {
    assert.throws(() => parse(pasted, own), /invalid/);
  }
});

// The explicit sign-in registry over the real client, as a remote (no
// browser) session runtime wires it; a browser opening anywhere fails.
async function remoteLogins(server, scopeId) {
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  const { cancelMcpLogin, completeMcpLogin, reconnectSingleMcpServer } = await import('./client.mjs');
  const completed = [];
  const logins = createMcpOAuthLogins({
    async connect(name, launch) {
      try {
        await reconnectSingleMcpServer(
          scopeId,
          name,
          { type: 'http', url: server.url },
          { interactive: true, openBrowser: launch }
        );
        return { connected: true };
      } catch (error) {
        return { connected: false, error: error.authRequired ? null : error.message };
      }
    },
    cancel: (name) => cancelMcpLogin(name, { scopeId }),
    completeCallback: (name, callbackUrl) => completeMcpLogin(name, callbackUrl, { scopeId }),
    onComplete: (name) => completed.push(name),
    openBrowser: () => assert.fail('no browser may open'),
  });
  return { logins, completed, completeMcpLogin };
}

test('remote sign-in: a no-browser begin returns the URL and a pasted callback completes it like the loopback', async (t) => {
  const scopeId = 'oauth-paste';
  const { disconnectMcpServer, getMcpServerOAuthState } = await import('./client.mjs');
  const server = await fixture(t);
  t.after(async () => {
    await disconnectMcpServer('paste', { scopeId });
    await clearMcpOAuth({ url: server.url });
  });
  const { logins, completed } = await remoteLogins(server, scopeId);
  const begun = await logins.begin('paste', { openBrowser: false });
  assert.equal(begun.state, 'pending');
  const authorization = new URL(begun.url);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const redirect = authorization.searchParams.get('redirect_uri');
  const pasted = server.callbackFor(begun.url);
  // An invalid paste leaves the flow pending for another try, never echoed.
  for (const bad of [pasted.replace('state=', 'state=x'), `${pasted}#frag`, `${pasted}&code=other`]) {
    await assert.rejects(logins.complete(begun.flowId, bad), (error) => {
      assert.doesNotMatch(error.message, /fixture-code|state=/);
      return /invalid/.test(error.message);
    });
  }
  assert.equal(logins.status(begun.flowId).state, 'pending');
  assert.equal(server.exchanges(), 0);
  assert.deepEqual(await logins.complete(begun.flowId, pasted), { flowId: begun.flowId, state: 'complete' });
  assert.equal(server.exchanges(), 1);
  assert.deepEqual(completed, ['paste']);
  // The fixture's token response names nobody: no identity is invented.
  assert.deepEqual(getMcpServerOAuthState({ type: 'http', url: server.url }), {
    signedIn: true,
    account: '',
    workspace: '',
    forcedAccountChoice: false,
  });
  // The loopback listener is closed and the flow answered once.
  await assert.rejects(fetch(redirect));
  await assert.rejects(logins.complete(begun.flowId, pasted), /no longer pending/);
});

test('remote sign-in: a pasted denial fails the flow without echoing it; a paste after cancel is refused', async (t) => {
  const scopeId = 'oauth-paste-fail';
  const denied = await fixture(t);
  t.after(() => clearMcpOAuth({ url: denied.url }));
  const first = await remoteLogins(denied, scopeId);
  const begun = await first.logins.begin('denied', { openBrowser: false });
  const result = await first.logins.complete(
    begun.flowId,
    denied.callbackFor(begun.url, { error: 'access_denied', error_description: 'secret-reason' })
  );
  assert.equal(result.state, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /secret-reason|access_denied/);
  assert.equal(denied.exchanges(), 0);

  const cancelled = await fixture(t);
  t.after(() => clearMcpOAuth({ url: cancelled.url }));
  const second = await remoteLogins(cancelled, scopeId);
  const flow = await second.logins.begin('cancelled', { openBrowser: false });
  const pasted = cancelled.callbackFor(flow.url);
  assert.deepEqual(await second.logins.cancel(flow.flowId), { flowId: flow.flowId, state: 'cancelled' });
  await assert.rejects(second.logins.complete(flow.flowId, pasted), /no longer pending/);
  // Below the registry too: no login of that server waits for a callback.
  assert.throws(() => second.completeMcpLogin('cancelled', pasted, { scopeId }), /not waiting for a callback/);
  assert.equal(cancelled.exchanges(), 0);
});

// The token endpoint names the account (an OIDC id_token) for these tests.
const idToken = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
function namingFetch(email) {
  const fetchImpl = async (input, init = {}) => {
    const response = await fetch(input, init);
    if (!String(init.body ?? '').includes('grant_type=authorization_code') || !response.ok) return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, id_token: idToken({ email: email.value }) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return fetchImpl;
}
function countingStore() {
  const store = memoryStore();
  store.reads = 0;
  store.writes = 0;
  const get = store.getSecretAsync;
  const set = store.setSecretAsync;
  store.getSecretAsync = async (key) => {
    store.reads++;
    return get(key);
  };
  store.setSecretAsync = async (key, value) => {
    store.writes++;
    return set(key, value);
  };
  return store;
}

test('the account parameters are only the documented ones, per provider and mode', () => {
  const at = (url, mode) => Object.fromEntries(withAccountParams(url, mode).searchParams);
  const google = 'https://accounts.google.com/o/oauth2/v2/auth?state=s';
  assert.equal(at(google, 'connect').prompt, 'select_account');
  assert.equal(at('https://github.com/login/oauth/authorize?state=s', 'connect').prompt, 'select_account');
  // A normal connect adds nothing where the chooser is not the documented choice.
  for (const url of [
    'https://auth.atlassian.com/authorize?state=s',
    'https://mcp.notion.com/authorize?state=s',
    'https://www.dropbox.com/oauth2/authorize?state=s',
  ]) {
    assert.equal(at(url, 'connect').prompt, undefined);
  }
  assert.equal(at('https://auth.atlassian.com/authorize?state=s', 'switch').prompt, 'consent');
  assert.equal(at('https://mcp.linear.app/authorize?state=s', 'switch').prompt, 'consent');
  assert.equal(at('https://www.dropbox.com/oauth2/authorize?state=s', 'switch').force_reapprove, 'true');
  // Asana is not in the catalog: its authorization URL gets nothing added.
  assert.deepEqual(at('https://app.asana.com/-/oauth_authorize?state=s', 'switch'), { state: 's' });
  assert.deepEqual(at('https://mcp.notion.com/authorize?state=s', 'switch'), { state: 's' });
  // A repair keeps the same account: nothing is added.
  assert.deepEqual(at(google, 'reauth'), { state: 's' });
  // The SDK's consent for offline access is kept beside the chooser.
  assert.equal(at(`${google}&prompt=consent`, 'connect').prompt, 'consent select_account');
  assert.equal(canForceAccountChoice('https://mcp.notion.com/authorize'), false);
  assert.equal(canForceAccountChoice('https://www.dropbox.com/oauth2/authorize'), true);
});

test('the identity is read from the token response only, never guessed', () => {
  assert.deepEqual(identityFromTokenResponse({ id_token: idToken({ email: 'a@example.com' }) }), {
    account: 'a@example.com',
    workspace: '',
  });
  assert.deepEqual(
    identityFromTokenResponse({ workspace_name: 'Acme', owner: { user: { person: { email: 'n@acme.io' } } } }),
    { account: 'n@acme.io', workspace: 'Acme' }
  );
  assert.deepEqual(identityFromTokenResponse({ team: { name: 'Acme Slack' } }), {
    account: '',
    workspace: 'Acme Slack',
  });
  assert.equal(identityFromTokenResponse({ access_token: 't', token_type: 'Bearer' }), null);
  assert.equal(identityFromTokenResponse({ id_token: 'not-a-jwt' }), null);
});

test('a sign-in stores who it is, and reads the keychain only when the stored entry changed', async (t) => {
  const server = await fixture(t);
  const store = countingStore();
  const email = { value: 'first@example.com' };
  t.after(() => clearMcpOAuth({ url: server.url, credentialStore: store }));
  const oauth = buildOAuth({
    url: server.url,
    credentialStore: store,
    interactive: true,
    fetchImpl: namingFetch(email),
    openBrowser: (href) => server.approve(href),
  });
  t.after(() => oauth.close());
  assert.equal((await oauth.fetch(server.url)).status, 405);
  assert.equal(server.exchanges(), 1);
  // Each keychain read is a DPAPI PowerShell round trip on Windows: an entry
  // this process just wrote is never re-read, and the discovery is no write
  // of its own.
  assert.ok(store.reads <= 3, `keychain reads: ${store.reads}`);
  assert.equal(store.writes, 2, 'the registration and the tokens; discovery rides along');
  const stored = JSON.parse([...store.values.values()][0]);
  assert.deepEqual(stored.identity, { account: 'first@example.com', workspace: '' });
  assert.ok(stored.discovery?.authorizationServerMetadata, 'the discovery is stored with them');
  assert.deepEqual(storedMcpOAuthIdentity(server.url), {
    account: 'first@example.com',
    workspace: '',
    forcedChoice: false,
  });
});

test('계정 바꾸기 is transactional: a cancel changes nothing; a commit can be rolled back', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  const email = { value: 'first@example.com' };
  const fetchImpl = namingFetch(email);
  t.after(() => clearMcpOAuth({ url: server.url, credentialStore: store }));
  const oauth = buildOAuth({
    url: server.url,
    credentialStore: store,
    interactive: true,
    fetchImpl,
    openBrowser: (href) => server.approve(href),
  });
  t.after(() => oauth.close());
  await oauth.fetch(server.url);
  const before = [...store.values.values()][0];
  const registrations = server.registrations();

  // Cancelled at the sign-in page: the stored sign-in is untouched.
  let opened;
  const openedOnce = new Promise((resolve) => {
    opened = resolve;
  });
  const launch = async (href) => opened(href);
  launch.accountMode = 'switch';
  const cancelled = startMcpOAuthSwitch({ url: server.url, launch, credentialStore: store, fetchImpl });
  await openedOnce;
  cancelled.cancel();
  await assert.rejects(cancelled.done);
  assert.equal([...store.values.values()][0], before);

  // Completed: nothing is stored until the commit, which keeps the client.
  email.value = 'second@example.com';
  const approving = async (href) => server.approve(href);
  approving.accountMode = 'switch';
  const switched = startMcpOAuthSwitch({ url: server.url, launch: approving, credentialStore: store, fetchImpl });
  const signIn = await switched.done;
  assert.deepEqual(signIn.identity, { account: 'second@example.com', workspace: '' });
  assert.equal([...store.values.values()][0], before, 'the old sign-in stays until committed');
  assert.equal(server.registrations(), registrations, 'the existing client registration is reused');
  const rollback = await commitMcpOAuthSwitch({ url: server.url, signIn, credentialStore: store });
  assert.equal(JSON.parse([...store.values.values()][0]).identity.account, 'second@example.com');
  assert.equal(storedMcpOAuthIdentity(server.url).account, 'second@example.com');
  await rollback();
  assert.equal(JSON.parse([...store.values.values()][0]).identity.account, 'first@example.com');
  assert.equal(storedMcpOAuthIdentity(server.url).account, 'first@example.com');
});

// A pre-registered client with its own scopes (Google's): the token endpoint is
// answered here, with `scope` as given (undefined: the field is absent).
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const scopedClient = { clientId: 'scoped-client', scopes: ['openid', 'email', CALENDAR] };
function scopedTokenFetch(grantedScope) {
  const fetchImpl = async (input, init = {}) => {
    if (!String(input).endsWith('/token')) return fetch(input, init);
    return Response.json({
      access_token: 'fixture-token',
      refresh_token: 'fixture-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      ...(grantedScope === undefined ? {} : { scope: grantedScope }),
    });
  };
  return fetchImpl;
}
// The callback page answers after the exchange (which starts when this step
// returns): its response is collected in `pages`, never awaited here.
function approvingBrowser(opened, pages = []) {
  return async (href) => {
    opened.push(href);
    const authorization = new URL(href);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code');
    const page = fetch(callback);
    page.catch(() => {});
    pages.push(page);
  };
}

test('a sign-in whose token response lacks a requested scope fails, stores no tokens and asks again next time', async (t) => {
  const server = await fixture(t);
  const store = memoryStore();
  const opened = [];
  t.after(() => clearMcpOAuth({ url: server.url, credentialStore: store }));
  const pages = [];
  const connect = (granted) =>
    buildOAuth({
      url: server.url,
      credentialStore: store,
      interactive: true,
      serverName: 'Google Drive',
      oauthClient: scopedClient,
      fetchImpl: scopedTokenFetch(granted),
      openBrowser: approvingBrowser(opened, pages),
    });
  // Google's granular consent: the Calendar box left unchecked.
  const denied = connect('https://www.googleapis.com/auth/userinfo.email openid');
  await assert.rejects(denied.fetch(server.url), (error) => {
    assert.equal(error.code, 'scopeNotGranted');
    assert.match(error.message, /calendar\.events/);
    assert.doesNotMatch(error.message, /fixture-token|fixture-refresh|fixture-code/);
    assert.deepEqual(error.missingScopes, [CALENDAR]);
    return true;
  });
  denied.close();
  // The browser page reports the real outcome, not the arrival of the code.
  const failure = await pages[0];
  assert.equal(failure.status, 400);
  assertCallbackPage(failure);
  const failureHtml = await failure.text();
  assert.match(failureHtml, /로그인 실패[\s\S]*Sign-in failed/);
  assert.match(
    failureHtml,
    /Google Drive 접근 권한이 허용되지 않았습니다\. Mixdog로 돌아가 다시 연결하고, 권한 확인란을 체크해 주세요/
  );
  assert.match(
    failureHtml,
    /Access to Google Drive was not granted\. Return to Mixdog and connect again with the access box checked/
  );
  assert.doesNotMatch(
    failureHtml,
    /로그인 완료|Sign-in complete|fixture-token|fixture-refresh|fixture-code|calendar\.events/
  );
  assert.equal(hasStoredMcpOAuthTokens(server.url), false);
  for (const saved of store.values.values()) assert.equal(JSON.parse(saved).tokens, undefined);
  assert.equal(opened.length, 1);
  // The next connect opens the consent screen again; this time it is granted.
  const granted = connect(`openid https://www.googleapis.com/auth/userinfo.email ${CALENDAR}`);
  t.after(() => granted.close());
  assert.equal((await granted.fetch(server.url)).status, 405);
  assert.equal(opened.length, 2);
  assert.equal(hasStoredMcpOAuthTokens(server.url), true);
  const success = await pages[1];
  assert.equal(success.status, 200);
  assert.match(await success.text(), /Google Drive 로그인이 완료되었습니다\./);
});

test('a sign-in whose code exchange fails gets a generic failure page that echoes nothing from the server', async (t) => {
  const server = await fixture(t);
  const pages = [];
  const oauth = buildOAuth({
    url: server.url,
    credentialStore: memoryStore(),
    interactive: true,
    serverName: 'Fixture',
    fetchImpl: async (input, init = {}) =>
      String(input).endsWith('/token')
        ? Response.json(
            { error: 'server_error', error_description: 'leak-sdk-detail fixture-refresh' },
            { status: 500 }
          )
        : fetch(input, init),
    openBrowser: approvingBrowser([], pages),
  });
  t.after(() => oauth.close());
  await assert.rejects(oauth.fetch(server.url), /MCP OAuth login failed, cancelled, or timed out/);
  const page = await pages[0];
  assert.equal(page.status, 400);
  assertCallbackPage(page);
  const html = await page.text();
  assert.match(html, /Fixture 로그인을 완료하지 못했습니다\./);
  assert.match(html, /Sign-in to Fixture could not be completed\./);
  assert.doesNotMatch(html, /leak-sdk-detail|fixture-refresh|fixture-code|로그인 완료|Sign-in complete|server_error/);
  assert.doesNotMatch(html, /connect again with the access box/);
});

// A credential store whose write of the signed-in tokens waits on a gate:
// `stalled` resolves when the write starts, `fail()` makes it fail (the write
// is a stand-in for a store that errors out after the deadline).
function stallingStore() {
  const store = memoryStore();
  let started;
  let fail;
  let release;
  const stalled = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve, reject) => {
    fail = () => reject(new Error('credential store unavailable'));
    release = resolve;
  });
  gate.catch(() => {});
  const write = store.setSecretAsync;
  store.setSecretAsync = async (key, value) => {
    if (!String(value).includes('"tokens":{')) return write(key, value);
    started();
    await gate;
    return write(key, value);
  };
  return { store, stalled, fail, release };
}

for (const mode of ['deadline', 'cancel']) {
  test(`${mode} while the token write stalls, then the write succeeds: no tokens stay stored and the login fails`, async (t) => {
    const server = await fixture(t);
    const { store, stalled, release } = stallingStore();
    const browser = approvingBrowser([], []);
    const oauth = buildOAuth({
      url: server.url,
      credentialStore: store,
      interactive: true,
      serverName: 'Fixture',
      timeoutMs: mode === 'deadline' ? 1500 : 3000,
      openBrowser: async (href) => {
        server.callbackFor(href);
        await browser(href);
      },
    });
    t.after(() => oauth.close());
    const settled = oauth.fetch(server.url).then(
      () => undefined,
      (error) => error
    );
    await stalled;
    if (mode === 'cancel') oauth.close();
    else await new Promise((resolve) => setTimeout(resolve, 1700));
    release();
    assert.ok(await settled, 'the login that outlived its deadline or cancel fails');
    assert.ok(store.values.size > 0);
    for (const saved of store.values.values()) assert.equal(JSON.parse(saved).tokens, undefined);
  });

  test(`${mode} while the token write stalls: the held callback page gets the failure page and the listener closes`, async (t) => {
    const server = await fixture(t);
    const { store, stalled, fail } = stallingStore();
    const pages = [];
    let callback;
    const browser = approvingBrowser([], pages);
    const oauth = buildOAuth({
      url: server.url,
      credentialStore: store,
      interactive: true,
      serverName: 'Fixture',
      timeoutMs: 3000,
      openBrowser: async (href) => {
        callback = new URL(new URL(href).searchParams.get('redirect_uri'));
        server.callbackFor(href); // the fixture checks the exchange against this authorization
        await browser(href);
      },
    });
    t.after(() => oauth.close());
    const login = oauth.fetch(server.url);
    const settled = login.then(
      () => undefined,
      (error) => error
    );
    try {
      await stalled;
      // The exchange is done and the page is held; only persistence is stuck.
      assert.equal(server.exchanges(), 1);
      if (mode === 'cancel') oauth.close();
      const page = await pages[0];
      assert.equal(page.status, 400);
      assertCallbackPage(page);
      const html = await page.text();
      assert.match(html, /Fixture 로그인을 완료하지 못했습니다\./);
      assert.match(html, /Sign-in to Fixture could not be completed\./);
      assert.doesNotMatch(html, /로그인 완료|Sign-in complete|fixture-code|fixture-token/);
      await assert.rejects(fetch(callback));
    } finally {
      // End the stalled write so the login finishes and frees its lock.
      fail();
    }
    const error = await settled;
    assert.ok(error, 'the login that outlived its deadline or cancel fails');
    for (const saved of store.values.values()) assert.equal(JSON.parse(saved).tokens, undefined);
  });
}

test('the callback page names a catalog connector by its display name and a custom server by its own name', async (t) => {
  assert.equal(mcpOAuthDisplayName({ connector: 'google-drive' }, 'google-drive'), 'Google Drive');
  assert.equal(mcpOAuthDisplayName({ connector: 'no-such-connector' }, 'mine'), 'mine');
  assert.equal(mcpOAuthDisplayName({ type: 'http' }, 'mine'), 'mine');
  const pageOf = async (name, cfg) => {
    const server = await fixture(t);
    const { transport } = createMcpTransport({
      name,
      cfg: { type: 'http', url: server.url, ...cfg },
      sdk: { StreamableHTTPClientTransport, SSEClientTransport },
      log: () => {},
      oauthOptions: { openBrowser: (href) => server.approve(href) },
    });
    t.after(() => transport.close());
    assert.equal((await transport.oauth.fetch(server.url)).status, 405);
    return (await server.page()).text();
  };
  const catalog = await pageOf('notion-2', { connector: 'notion' });
  assert.match(catalog, /Notion 로그인이 완료되었습니다\./);
  assert.doesNotMatch(catalog, /notion-2/);
  assert.match(await pageOf('my-docs', {}), /my-docs 로그인이 완료되었습니다\./);
});

test('email vs userinfo.email and an absent scope field do not fail a sign-in', async (t) => {
  for (const granted of [
    `openid email ${CALENDAR}`,
    `https://www.googleapis.com/auth/userinfo.email openid ${CALENDAR}`,
    undefined,
  ]) {
    const server = await fixture(t);
    const store = memoryStore();
    t.after(() => clearMcpOAuth({ url: server.url, credentialStore: store }));
    const oauth = buildOAuth({
      url: server.url,
      credentialStore: store,
      interactive: true,
      oauthClient: scopedClient,
      fetchImpl: scopedTokenFetch(granted),
      openBrowser: approvingBrowser([]),
    });
    t.after(() => oauth.close());
    assert.equal((await oauth.fetch(server.url)).status, 405, String(granted));
    assert.equal(hasStoredMcpOAuthTokens(server.url), true);
  }
});

test('the scope check applies to browser sign-ins only: a refresh response is stored as it is', async () => {
  const stored = {};
  const cache = {
    creds: stored,
    ready: async () => {},
    update: async (change) => {
      change();
      return true;
    },
  };
  const provider = (browserOpened) =>
    createOAuthProvider({
      cache,
      flow: { browserOpened },
      lifetimeSignal: new AbortController().signal,
      client: scopedClient,
    });
  const refreshed = { access_token: 'a', token_type: 'Bearer', scope: 'openid' };
  await provider(false).saveTokens(refreshed);
  assert.equal(stored.tokens, refreshed);
  stored.tokens = undefined;
  await assert.rejects(provider(true).saveTokens(refreshed), { code: 'scopeNotGranted' });
  assert.equal(stored.tokens, undefined);
  // Only a client with its own scopes is checked.
  await createOAuthProvider({
    cache,
    flow: { browserOpened: true },
    lifetimeSignal: new AbortController().signal,
    client: { clientId: 'plain' },
  }).saveTokens(refreshed);
  assert.equal(stored.tokens, refreshed);
});

test('missingScopes ignores the basic identity scopes and a response without a scope field', () => {
  const requested = ['openid', 'email', 'profile', CALENDAR];
  assert.deepEqual(missingScopes(requested, 'https://www.googleapis.com/auth/userinfo.email openid'), [CALENDAR]);
  assert.deepEqual(missingScopes(requested, CALENDAR), []);
  assert.deepEqual(missingScopes(requested, undefined), []);
  assert.deepEqual(missingScopes(['openid', 'email'], 'openid'), []);
});

test('the scope error reaches the connect failure with its message and is not a plain sign-in-required', async (t) => {
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  const server = await fixture(t);
  const { transport } = createMcpTransport({
    name: 'fixture',
    cfg: { type: 'http', url: server.url },
    sdk: { StreamableHTTPClientTransport, SSEClientTransport },
    log: () => {},
    oauthOptions: {
      oauthClient: scopedClient,
      fetchImpl: scopedTokenFetch('openid'),
      openBrowser: approvingBrowser([]),
    },
  });
  t.after(() => transport.close());
  await assert.rejects(
    runBoundedHandshake({
      name: 'fixture',
      cfg: {},
      client: new Client({ name: 'test', version: '1' }),
      transport,
      closeServer: () => transport.close(),
    }),
    (error) => isMcpOAuthScopeNotGranted(error) && /calendar\.events/.test(error.message)
  );
  assert.equal(hasStoredMcpOAuthTokens(server.url), false);
});

test('disconnect revokes the grant only through an advertised revocation endpoint', async () => {
  const url = 'https://revoke.example/mcp';
  const account = mcpOAuthAccount(url);
  const posted = [];
  const fetchImpl = async (endpoint, init) => {
    posted.push([endpoint, String(init.body)]);
    return new Response('', { status: 200 });
  };
  const entry = (metadata) =>
    JSON.stringify({
      url,
      revision: 'r',
      tokens: { access_token: 'a', refresh_token: 'r1', token_type: 'Bearer' },
      clientInformation: { client_id: 'c1' },
      discovery: { authorizationServerMetadata: metadata },
    });
  const store = memoryStore(new Map([[account, entry({ revocation_endpoint: 'https://revoke.example/revoke' })]]));
  assert.deepEqual(await clearMcpOAuth({ url, credentialStore: store, revoke: true, fetchImpl }), { revoked: true });
  assert.deepEqual(posted, [['https://revoke.example/revoke', 'token=r1&token_type_hint=refresh_token&client_id=c1']]);
  assert.equal(store.values.size, 0, 'the local secrets are gone either way');
  // No documented endpoint: nothing is sent, and the caller is told so.
  posted.length = 0;
  const bare = memoryStore(new Map([[account, entry({})]]));
  assert.deepEqual(await clearMcpOAuth({ url, credentialStore: bare, revoke: true, fetchImpl }), { revoked: false });
  assert.deepEqual(posted, []);
  assert.equal(bare.values.size, 0);
});
