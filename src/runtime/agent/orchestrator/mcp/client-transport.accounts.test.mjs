import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { connectorAccountHealth } from '../../../connectors/connector-accounts-mcp.mjs';
import { gmailAppPasswordSecretAccount } from '../../../connectors/gmail-app-password.mjs';
import { GMAIL_APP_PASSWORD, withConnectorAccountEnabled } from '../../../shared/connector-catalog.mjs';
import { createMcpTransport } from './client-transport.mjs';
import { mcpOAuthClientSecretAccount } from './oauth-client.mjs';

const SDK = { Client, StreamableHTTPClientTransport, SSEClientTransport, StdioClientTransport };
const APP_PASSWORD = 'abcdwxyzabcdwxyz';
const CLIENT_SECRET = 'client-secret-do-not-leak';
const ADDRESS = 'me@example.com';

// The app password lives in the OS keychain; back it with memory so the test
// runs where there is none.
const secrets = new Map([[gmailAppPasswordSecretAccount(ADDRESS), APP_PASSWORD]]);
Object.assign(keychain, {
  getSecretAsync: async (key) => secrets.get(key) ?? null,
  setSecretAsync: async (key, value) => void secrets.set(key, value),
  deleteSecretAsync: async (key) => void secrets.delete(key),
});

// An OAuth server whose MCP endpoint always challenges and whose token
// endpoint refuses every refresh.
async function deadOAuthServer(t) {
  let origin;
  const server = createServer((req, res) => {
    const path = new URL(req.url, origin).pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
    } else if (path.startsWith('/.well-known/')) {
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      );
    } else if (path === '/token') {
      res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
    } else {
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `${origin}/mcp`;
}

test('a multi-account server lists tools, flags the signed-out account, and leaks no secret', async (t) => {
  const oauthUrl = await deadOAuthServer(t);
  secrets.set(mcpOAuthClientSecretAccount(oauthUrl), CLIENT_SECRET);
  const { transport } = createMcpTransport({
    name: 'gmail',
    cfg: {
      type: 'http',
      connector: 'gmail',
      url: 'https://connectors.mixdog.invalid/gmail/mcp',
      accounts: [
        {
          name: 'gmail',
          url: GMAIL_APP_PASSWORD.url,
          headers: { [GMAIL_APP_PASSWORD.accountHeader]: ADDRESS },
        },
        { name: 'gmail-2', url: oauthUrl, oauthClientId: 'client-id' },
      ],
    },
    sdk: SDK,
    log: () => {},
    oauthOptions: {
      credentialStore: {
        getSecretAsync: async (key) => secrets.get(key) ?? null,
        setSecretAsync: async (key, value) => void secrets.set(key, value),
        deleteSecretAsync: async (key) => void secrets.delete(key),
      },
      openBrowser: () => assert.fail('a tool connection must not open a sign-in'),
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);

  // The tools the app-password account's own server lists.
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'search_emails'));
  assert.ok(listed.tools.every((tool) => tool.inputSchema.properties.account));
  assert.ok(!listed.tools.some((tool) => tool.name === 'describe_emails'), 'the approval-only tool stays unlisted');

  const failing = connectorAccountHealth('gmail-2');
  assert.equal(failing.authRequired, true);
  assert.match(failing.error, /Sign-in required/);
  assert.equal(connectorAccountHealth('gmail').authRequired, false);
  assert.equal(connectorAccountHealth('gmail').error, '');

  // The signed-out account is refused with the usable ones, never replaced by one.
  const call = await client.callTool({ name: listed.tools[0].name, arguments: { account: 'gmail-2' } });
  assert.equal(call.isError, true);
  assert.match(
    call.content[0].text,
    new RegExp(`gmail-2 needs a sign-in in Connectors\\. Usable Gmail accounts: ${ADDRESS}\\.`)
  );

  const everything = JSON.stringify({
    listed,
    call,
    instructions: client.getInstructions(),
    health: [connectorAccountHealth('gmail'), connectorAccountHealth('gmail-2')],
  });
  assert.match(client.getInstructions(), /needs sign-in/);
  for (const secret of [APP_PASSWORD, CLIENT_SECRET]) assert.equal(everything.includes(secret), false);
});

// A configured-auth account's own MCP server: it lists one tool and records
// every request's method. With `hang`, it holds every tools/call open:
// `calling` resolves when one arrives, `aborted` when it is cancelled
// (notifications/cancelled) or its connection drops.
async function accountServer(t, { hang = false } = {}) {
  const requests = [];
  let drop;
  const aborted = new Promise((resolve) => (drop = resolve));
  let started;
  const calling = new Promise((resolve) => (started = resolve));
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body);
      requests.push(message.method);
      if (message.method === 'notifications/cancelled') drop();
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (hang && message.method === 'tools/call') {
        res.on('close', drop);
        started();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'account', version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'do_it', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: 'ok' }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests, aborted, calling };
}

const calls = (requests) => requests.filter((method) => method === 'tools/call').length;

async function connectHangingAccount(t) {
  const account = await accountServer(t, { hang: true });
  const { transport } = createMcpTransport({
    name: 'gmail',
    cfg: {
      type: 'http',
      connector: 'gmail',
      url: 'https://connectors.mixdog.invalid/gmail/mcp',
      accounts: [{ name: 'gmail', url: account.url, headers: { 'x-api-key': 'k' } }],
    },
    sdk: SDK,
    log: () => {},
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { ...account, client, transport, tool: tools[0].name };
}

const accountsCfg = (accounts) => ({
  type: 'http',
  connector: 'gmail',
  url: 'https://connectors.mixdog.invalid/gmail/mcp',
  accounts,
});

test('a disabled account is neither connected nor called', async (t) => {
  const live = await accountServer(t);
  const off = await accountServer(t);
  const { transport } = createMcpTransport({
    name: 'gmail',
    cfg: accountsCfg([
      { name: 'gmail', url: live.url, headers: { 'x-api-key': 'k' } },
      { name: 'gmail-2', url: off.url, headers: { 'x-api-key': 'k' }, enabled: false },
    ]),
    sdk: SDK,
    log: () => {},
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();

  // Naming the disabled account is refused, listing only the live one.
  const refused = await client.callTool({ name: tools[0].name, arguments: { account: 'gmail-2' } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /No connected Gmail account is "gmail-2"\. Usable Gmail accounts: gmail\./);
  // With one live account the call needs no `account` and goes to it alone.
  const call = await client.callTool({ name: tools[0].name, arguments: {} });
  assert.equal(call.isError, undefined);
  assert.equal(calls(live.requests), 1);
  assert.deepEqual(off.requests, []);
});

test('an account turned back on is connected again and receives calls', async (t) => {
  const live = await accountServer(t);
  const back = await accountServer(t);
  const disabled = accountsCfg([
    { name: 'gmail', url: live.url, headers: { 'x-api-key': 'k' } },
    { name: 'gmail-2', url: back.url, headers: { 'x-api-key': 'k' }, enabled: false },
  ]);
  const { transport } = createMcpTransport({
    name: 'gmail',
    cfg: withConnectorAccountEnabled(disabled, 'gmail-2', true),
    sdk: SDK,
    log: () => {},
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();

  const call = await client.callTool({ name: tools[0].name, arguments: { account: 'gmail-2' } });
  assert.equal(call.isError, undefined);
  assert.equal(calls(back.requests), 1);
  assert.equal(calls(live.requests), 0);
  assert.ok(live.requests.includes('initialize'));
});

test('a connector whose every account is disabled does not connect', (t) => {
  assert.throws(
    () =>
      createMcpTransport({
        name: 'gmail',
        cfg: accountsCfg([
          { name: 'gmail', url: 'http://127.0.0.1:1/mcp', headers: { 'x-api-key': 'k' }, enabled: false },
        ]),
        sdk: SDK,
        log: () => {},
      }),
    /Every account of "gmail" is disabled/
  );
});

// A local (stdio) account's server: answers with its pid and its connection string.
const STDIO_ACCOUNT = `
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize'
    ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pg', version: '1' } }
    : m.method === 'tools/list'
      ? { tools: [{ name: 'query', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: process.pid + ':' + process.env.PG_URL }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`;

test('a local account runs one process per account, shared by the connector server of every scope', async (t) => {
  const account = (name, value) => ({
    name,
    type: 'stdio',
    command: process.execPath,
    args: ['-e', STDIO_ACCOUNT],
    env: { PG_URL: value },
  });
  const cfg = {
    type: 'http',
    connector: 'postgres',
    url: 'https://connectors.mixdog.invalid/postgres/mcp',
    accounts: [account('postgres', 'one'), account('postgres-2', 'two')],
  };
  const answer = async (client, name) =>
    (await client.callTool({ name: 'query', arguments: { account: name } })).content[0].text.split(':');
  const scopes = [];
  for (let index = 0; index < 2; index += 1) {
    const { transport } = createMcpTransport({ name: 'postgres', cfg, sdk: SDK, log: () => {} });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    scopes.push(client);
  }
  const [first, second] = scopes;
  const [pidOne, valueOne] = await answer(first, 'postgres');
  const [pidTwo, valueTwo] = await answer(first, 'postgres-2');
  assert.deepEqual([valueOne, valueTwo], ['one', 'two'], 'each account runs with its own connection string');
  assert.notEqual(pidOne, pidTwo);
  assert.deepEqual(await answer(second, 'postgres'), [pidOne, 'one'], 'the other scope uses the same process');
  assert.deepEqual(await answer(second, 'postgres-2'), [pidTwo, 'two']);
});

test('aborting a multi-account tool call cancels the downstream request', async (t) => {
  const { client, tool, aborted, calling } = await connectHangingAccount(t);
  const controller = new AbortController();
  const call = client.callTool({ name: tool, arguments: {} }, undefined, { signal: controller.signal });
  call.catch(() => {});
  await calling;
  controller.abort();
  await assert.rejects(call);
  await aborted;
});

test('closing a multi-account transport aborts in-flight configured-auth requests', async (t) => {
  const { client, transport, tool, aborted, calling } = await connectHangingAccount(t);
  const call = client.callTool({ name: tool, arguments: {} });
  call.catch(() => {});
  await calling;
  await transport.close();
  await aborted;
  await assert.rejects(call);
});
