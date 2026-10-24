// The built-in Google connectors end to end: the real MCP client and the real
// MCP OAuth sign-in (pre-registered Desktop client, PKCE S256, state, loopback
// redirect, access_type=offline) against a fake Google, with the REST calls
// the tools make.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GOOGLE_SCOPES } from '../shared/connector-catalog.mjs';
import { createMcpOAuth, mcpOAuthAccount } from '../agent/orchestrator/mcp/oauth.mjs';
import { mcpOAuthClientFor, mcpOAuthClientSecretAccount } from '../agent/orchestrator/mcp/oauth-client.mjs';
import { GOOGLE_OAUTH_CLIENT_FILE } from '../shared/google-oauth-client.mjs';
import { googleMcpService, googleMcpUrl, withGoogleMcp } from './google-mcp.mjs';

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

const idToken = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

/** Google's sign-in, token and REST endpoints, recording what they saw. */
function fakeGoogle() {
  const seen = { authorize: [], token: [], api: [], codes: new Map() };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const google = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === 'https://accounts.google.com/.well-known/openid-configuration') {
      return json({
        issuer: 'https://accounts.google.com',
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
        jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['plain', 'S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.hostname === 'accounts.google.com') return new Response('Not found', { status: 404 });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init.body));
      seen.token.push({ body, authorization: new Headers(init.headers).get('authorization') });
      const challenge = seen.codes.get(body.get('code'));
      const verifier = body.get('code_verifier') || '';
      if (challenge !== createHash('sha256').update(verifier).digest('base64url')) {
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_in: 3599,
        token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/gmail.send',
        id_token: idToken({ email: 'me@example.com' }),
      });
    }
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/tokeninfo') {
      return url.searchParams.get('access_token') === 'ya29.access' ? json({ aud: 'x' }) : json({}, 400);
    }
    seen.api.push({ url: url.href, method: init.method || 'GET', body: init.body, auth: init.headers?.authorization });
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return json({ id: 'm1' });
    return json({ error: { message: 'unexpected' } }, 500);
  };
  // The browser: Google approves and redirects to the loopback callback.
  const browser = async (href) => {
    const target = new URL(href);
    seen.authorize.push(target);
    const code = `code-${seen.authorize.length}`;
    seen.codes.set(code, target.searchParams.get('code_challenge'));
    const back = new URL(target.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', target.searchParams.get('state'));
    // The page answers after the code exchange, which starts once this returns.
    fetch(back).catch(() => {});
  };
  return { google, browser, seen };
}

test('the reserved address answers like a protected remote MCP server, and nothing else is intercepted', async () => {
  const url = googleMcpUrl('gmail');
  assert.equal(url, 'https://gmail.mixdog.invalid/mcp');
  assert.ok(googleMcpService(url));
  assert.equal(googleMcpService('https://evil.mixdog.invalid/mcp'), null);
  assert.equal(googleMcpService('https://gmailmcp.googleapis.com/mcp/v1'), null);
  const forwarded = [];
  const fetchImpl = withGoogleMcp(async (input) => {
    forwarded.push(String(input));
    return new Response('ok');
  });
  const prm = await (await fetchImpl('https://gmail.mixdog.invalid/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(prm.authorization_servers, ['https://accounts.google.com']);
  assert.equal(prm.resource, url);
  const anonymous = await fetchImpl(url, { method: 'POST', body: '{}' });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata=/);
  await fetchImpl('https://example.com/x');
  assert.deepEqual(forwarded, ['https://example.com/x']);
});

test('Calendar and Drive tools call their REST APIs with the bearer token', async () => {
  const calls = [];
  const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = withGoogleMcp(async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: init.method || 'GET', body: init.body, auth: init.headers?.authorization });
    if (url.pathname === '/tokeninfo') return reply({});
    if (url.pathname.endsWith('/events') && (init.method || 'GET') === 'GET') {
      return reply({ items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-10-20T09:00:00Z' } }] });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/drive/v3/files' && !url.searchParams.has('uploadType')) {
      return reply({ files: [{ id: 'f1', name: 'Plan' }] });
    }
    if (url.pathname === '/drive/v3/files/f1')
      return reply({ id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' });
    if (url.pathname === '/drive/v3/files/f1/export') return new Response('Plan body');
    if (url.searchParams.get('uploadType') === 'multipart') return reply({ id: 'f2', name: 'Notes' });
    return new Response('{}', { status: 500 });
  });
  const call = async (service, name, args) => {
    const response = await fetchImpl(googleMcpUrl(service), {
      method: 'POST',
      headers: { authorization: 'Bearer t1', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  const listed = await call('calendar', 'list_events', { query: 'standup' });
  assert.match(listed.content[0].text, /"summary":"Standup"/);
  const list = calls.at(-1);
  assert.equal(list.auth, 'Bearer t1');
  assert.equal(list.url.searchParams.get('q'), 'standup');
  assert.equal(list.url.searchParams.get('singleEvents'), 'true');
  assert.equal((await call('calendar', 'delete_event', { eventId: 'e1' })).content[0].text, 'Deleted.');
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.match((await call('drive', 'search_files', { query: "o'neil" })).content[0].text, /"id":"f1"/);
  assert.equal(calls.at(-1).url.searchParams.get('q'), "trashed = false and name contains 'o\\'neil'");
  assert.match((await call('drive', 'read_file', { fileId: 'f1' })).content[0].text, /Plan body$/);
  assert.equal(calls.at(-1).url.searchParams.get('mimeType'), 'text/plain');
  assert.match((await call('drive', 'create_file', { name: 'Notes', content: 'hi' })).content[0].text, /"id":"f2"/);
  assert.match(String(calls.at(-1).body), /"name":"Notes"[\s\S]*\r\nhi\r\n/);
  const missing = await call('calendar', 'create_event', { summary: 'x' });
  assert.equal(missing.isError, true);
});

test('Mixdog’s Google client, or the user’s own, replaces client registration', () => {
  const gmail = { type: 'http', url: googleMcpUrl('gmail'), connector: 'gmail' };
  const saved = { ...process.env };
  try {
    delete process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET;
    // Without an embedded client file (google-oauth-client.test.mjs covers the
    // file itself), the environment is the only source.
    if (!existsSync(GOOGLE_OAUTH_CLIENT_FILE)) {
      assert.throws(
        () => mcpOAuthClientFor(gmail, gmail.url),
        /clientUnavailable/,
        'the source ships no Google client, and Google never gets dynamic registration'
      );
    }
    process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID = 'mixdog.apps.googleusercontent.com';
    process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET = 'GOCSPX-public';
    assert.deepEqual(mcpOAuthClientFor(gmail, gmail.url), {
      clientId: 'mixdog.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-public',
      authParams: { access_type: 'offline' },
      scopes: [...GOOGLE_SCOPES.gmail],
    });
    const own = mcpOAuthClientFor({ ...gmail, oauthClientId: 'mine' }, gmail.url);
    assert.equal(own.clientId, 'mine');
    assert.equal(own.secretAccount, mcpOAuthClientSecretAccount(gmail.url));
    assert.equal(own.clientSecret, undefined, 'the user’s secret is read from the keychain only');
    assert.deepEqual(own.scopes, [...GOOGLE_SCOPES.gmail]);
    assert.deepEqual(own.authParams, { access_type: 'offline' });
    const { oauthClientId: _reverted, ...back } = { ...gmail, oauthClientId: 'mine' };
    assert.equal(mcpOAuthClientFor(back, gmail.url).clientId, 'mixdog.apps.googleusercontent.com');
    assert.equal(mcpOAuthClientFor({ type: 'http', url: 'https://mcp.notion.com/mcp', connector: 'notion' }), null);
  } finally {
    process.env = saved;
  }
});

test('connecting Gmail signs in with the pre-registered client and sends through the Gmail API', async (t) => {
  const { google, browser, seen } = fakeGoogle();
  const store = memoryStore();
  const url = googleMcpUrl('gmail');
  const oauthClient = {
    clientId: 'mixdog.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-public',
    authParams: { access_type: 'offline' },
    scopes: [...GOOGLE_SCOPES.gmail],
  };
  const oauth = createMcpOAuth({
    url,
    interactive: true,
    credentialStore: store,
    oauthClient,
    fetchImpl: withGoogleMcp(google),
    openBrowser: browser,
  });
  t.after(() => oauth.close());
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: oauth.fetch }));
  t.after(() => client.close());

  const [authorize] = seen.authorize;
  assert.equal(authorize.origin + authorize.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(authorize.searchParams.get('client_id'), oauthClient.clientId);
  assert.equal(authorize.searchParams.get('scope'), GOOGLE_SCOPES.gmail.join(' '));
  assert.equal(authorize.searchParams.get('access_type'), 'offline');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('prompt'), 'select_account');
  assert.equal(authorize.searchParams.get('resource'), null, 'no resource indicator for Google');
  assert.match(authorize.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\//);
  assert.ok(authorize.searchParams.get('state'));
  const [exchange] = seen.token;
  assert.equal(exchange.body.get('grant_type'), 'authorization_code');
  const secretSent =
    exchange.body.get('client_secret') === 'GOCSPX-public' ||
    Buffer.from(String(exchange.authorization).replace(/^Basic /, ''), 'base64')
      .toString()
      .endsWith(':GOCSPX-public');
  assert.ok(secretSent, 'the desktop client secret goes with the exchange');

  const stored = JSON.parse([...store.values.values()][0]);
  assert.equal(stored.tokens.refresh_token, '1//refresh');
  assert.equal(stored.identity.account, 'me@example.com');
  assert.equal(stored.clientInformation.client_id, oauthClient.clientId, 'kept for revocation');

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['send_email']
  );
  const result = await client.callTool({
    name: 'send_email',
    arguments: { to: 'a@example.com', subject: '안녕', body: 'Hello' },
  });
  assert.equal(result.isError, undefined);
  const [send] = seen.api;
  assert.equal(send.auth, 'Bearer ya29.access');
  const raw = Buffer.from(JSON.parse(send.body).raw, 'base64url').toString();
  assert.match(raw, /^To: a@example\.com\r\n/);
  assert.match(raw, new RegExp(`Subject: =\\?UTF-8\\?B\\?${Buffer.from('안녕').toString('base64')}\\?=`));
  const injected = await client.callTool({
    name: 'send_email',
    arguments: { to: 'a@example.com\r\nBcc: x@example.com', subject: 's', body: 'b' },
  });
  assert.equal(injected.isError, true);
  assert.equal(seen.api.length, 1, 'a header break is refused before Google is called');
});

test('a second Google account is its own server: its own URL and tokens, tools that name the account', async () => {
  const second = `${googleMcpUrl('gmail')}?account=gmail-2`;
  assert.ok(googleMcpService(second));
  assert.notEqual(mcpOAuthAccount(second), mcpOAuthAccount(googleMcpUrl('gmail')), 'tokens are kept per URL');
  const fetchImpl = withGoogleMcp(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/tokeninfo') {
      return new Response(
        JSON.stringify({ email: url.searchParams.get('access_token') === 't2' ? 'b@x.com' : 'a@x.com' })
      );
    }
    return new Response('{}', { status: 500 });
  });
  const rpc = async (url, token, method) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    });
    return (await response.json()).result;
  };
  const first = await rpc(googleMcpUrl('gmail'), 't1', 'initialize');
  assert.match(first.instructions, /^Account: a@x\.com\. /);
  const { tools } = await rpc(second, 't2', 'tools/list');
  assert.ok(tools.length > 0 && tools.every((tool) => tool.description.endsWith('(Gmail account: b@x.com)')));
});
