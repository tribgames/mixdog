import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { connectorAccountHealth } from '../../../connectors/connector-accounts-mcp.mjs';
import { gmailAppPasswordSecretAccount } from '../../../connectors/gmail-app-password.mjs';
import { GMAIL_APP_PASSWORD } from '../../../shared/connector-catalog.mjs';
import { createMcpTransport } from './client-transport.mjs';
import { mcpOAuthClientSecretAccount } from './oauth-client.mjs';

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
    sdk: { StreamableHTTPClientTransport, SSEClientTransport },
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

  const listed = await client.listTools();
  assert.ok(listed.tools.length > 0);
  assert.ok(listed.tools.every((tool) => tool.inputSchema.properties.account));

  const failing = connectorAccountHealth('gmail-2');
  assert.equal(failing.authRequired, true);
  assert.match(failing.error, /Sign-in required/);
  assert.equal(connectorAccountHealth('gmail').authRequired, false);
  assert.equal(connectorAccountHealth('gmail').error, '');

  // The signed-out account answers a call with a sign-in notice, not a throw.
  const call = await client.callTool({ name: listed.tools[0].name, arguments: { account: 'gmail-2' } });
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /Sign-in required/);

  const everything = JSON.stringify({
    listed,
    call,
    instructions: client.getInstructions(),
    health: [connectorAccountHealth('gmail'), connectorAccountHealth('gmail-2')],
  });
  assert.match(client.getInstructions(), /needs sign-in/);
  for (const secret of [APP_PASSWORD, CLIENT_SECRET]) assert.equal(everything.includes(secret), false);
});
