// A catalog connector with several accounts, end to end through the MCP
// client and the tool loop: one tool namespace, each account on its own
// credentials, the default following the account last used (in the
// conversation, then the connector's), an `account` argument switching it, an
// account that cannot be used failing closed, and an approval staying bound to
// the account resolved when it was asked.
import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { connectorAccountInUse } from '../../../connectors/connector-accounts-mcp.mjs';
import { connectorAccountsUrl } from '../../../shared/connector-catalog.mjs';
import { connectorAccountServers } from '../../../shared/connector-catalog.mjs';
import { executeTool } from '../session/loop/tool-exec.mjs';
import {
  connectMcpServers,
  disconnectAll,
  executeMcpTool,
  getMcpServerOAuthState,
  getMcpTools,
  resolveMcpToolAccount,
} from './client.mjs';
import { resolveMcpOAuthCredentialKey } from './client-config.mjs';
import { clearMcpOAuth, commitMcpOAuthSwitch } from './oauth.mjs';

process.env.MIXDOG_QUIET_MCP_LOG = '1';

/** One account's own MCP server (`label` answers): it lists `search` and
 *  records the key every request came with. */
async function accountServer(t, label) {
  const keys = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body);
      keys.push(req.headers['x-api-key']);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: label, version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'number' } } } }] }
            : { content: [{ type: 'text', text: `${label} searched ${JSON.stringify(message.params.arguments)}` }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, keys };
}

/** Connector `connector`'s one server over `accounts` (`[name, url, extra?]`). */
const connectorServer = (connector, accounts) => ({
  type: 'http',
  url: connectorAccountsUrl(connector),
  connector,
  accounts: accounts.map(([name, url, extra = {}]) => ({
    name,
    url,
    headers: { 'x-api-key': `key-${name}` },
    ...extra,
  })),
});

async function connect(t, scopeId, servers) {
  t.after(() => disconnectAll({ scopeId }));
  await connectMcpServers(servers, { scopeId });
}

const SEARCH = 'mcp__notion__search';

test('two accounts signing in at one remote URL keep independent credentials', async () => {
  const url = 'https://mcp.notion.com/mcp';
  const cfg = {
    type: 'http',
    url: connectorAccountsUrl('notion'),
    connector: 'notion',
    accounts: [
      { name: 'notion', url },
      { name: 'notion-2', url, oauthKey: 'second' },
    ],
  };
  const [first, second] = connectorAccountServers(cfg);
  assert.equal(resolveMcpOAuthCredentialKey(first), url, 'the first keeps what it was stored under');
  assert.equal(resolveMcpOAuthCredentialKey(second), 'mcp-account:second');
  const store = new Map();
  const credentialStore = {
    getSecretAsync: async (key) => store.get(key) ?? null,
    setSecretAsync: async (key, value) => void store.set(key, value),
    deleteSecretAsync: async (key) => void store.delete(key),
  };
  const signIn = (account) => ({
    tokens: { access_token: `token-${account}`, token_type: 'Bearer' },
    clientInformation: { client_id: 'client' },
    identity: { account, workspace: '' },
  });
  for (const [accountCfg, account] of [
    [first, 'me@home.example'],
    [second, 'me@work.example'],
  ]) {
    await commitMcpOAuthSwitch({
      url,
      credentialKey: resolveMcpOAuthCredentialKey(accountCfg),
      signIn: signIn(account),
      credentialStore,
    });
  }
  assert.equal(store.size, 2, 'one keychain entry each');
  assert.deepEqual(
    [getMcpServerOAuthState(first)?.account, getMcpServerOAuthState(second)?.account],
    ['me@home.example', 'me@work.example']
  );
  // Signing one out leaves the other signed in.
  await clearMcpOAuth({ url, credentialKey: resolveMcpOAuthCredentialKey(second), credentialStore });
  assert.equal(getMcpServerOAuthState(second).signedIn, false);
  assert.equal(getMcpServerOAuthState(first).account, 'me@home.example');
  assert.equal(store.size, 1);
});

test('two accounts are one connector: one namespace, their own keys, the last-used default and the `account` switch', async (t) => {
  const a = await accountServer(t, 'A');
  const b = await accountServer(t, 'B');
  const scopeId = 'accounts-default';
  await connect(t, scopeId, {
    notion: connectorServer('notion', [
      ['notion', a.url],
      ['notion-2', b.url],
    ]),
  });
  const tools = getMcpTools(scopeId);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [SEARCH],
    'one tool set, under the connector’s name'
  );
  assert.equal(tools[0].inputSchema.properties.account.type, 'string');
  assert.deepEqual(tools[0].inputSchema.properties.q, { type: 'number' }, 'the account’s own schema');

  const run = (args, conversation) => executeMcpTool(SEARCH, args, { scopeId, conversation });
  // Nothing used yet: the topmost account; the result names the account.
  assert.equal(await run({ q: 1 }, 'conv-a1'), 'A searched {"q":1}\n(Notion account: notion)');
  // Naming another switches to it and makes it the last used.
  assert.equal(await run({ account: 'notion-2', q: 2 }, 'conv-a1'), 'B searched {"q":2}\n(Notion account: notion-2)');
  assert.equal(connectorAccountInUse('notion'), 'notion-2');
  assert.match(await run({}, 'conv-a1'), /^B searched/, 'the conversation keeps it');
  assert.match(await run({}, 'conv-a2'), /^B searched/, 'a new conversation starts from the connector’s last used');
  assert.match(await run({ account: 'notion' }, 'conv-a2'), /^A searched/);
  assert.match(await run({}, 'conv-a1'), /^B searched/, 'its own conversation’s last used comes first');
  // Each account only ever sent its own key.
  assert.deepEqual([...new Set(a.keys)], ['key-notion']);
  assert.deepEqual([...new Set(b.keys)], ['key-notion-2']);
});

test('a remembered or named account that cannot be used fails closed; a single account is used as before', async (t) => {
  const a = await accountServer(t, 'A');
  const b = await accountServer(t, 'B');
  const scopeId = 'accounts-closed';
  await connect(t, scopeId, {
    notion: connectorServer('notion', [
      ['notion', a.url],
      ['notion-2', b.url],
    ]),
  });
  await executeMcpTool(SEARCH, { account: 'notion-2' }, { scopeId, conversation: 'conv-c1' });
  const before = b.keys.length;

  // The same conversation after notion-2 was switched off (here: another scope without it).
  const offScope = 'accounts-closed-off';
  await connect(t, offScope, {
    notion: connectorServer('notion', [
      ['notion', a.url],
      ['notion-2', b.url, { enabled: false }],
    ]),
  });
  const refusal =
    'The Notion account used last (notion-2) is not connected now. Usable Notion accounts: notion. Pass one as `account`.';
  assert.equal(await executeMcpTool(SEARCH, {}, { scopeId: offScope, conversation: 'conv-c1' }), `Error: ${refusal}`);
  assert.throws(() => resolveMcpToolAccount(SEARCH, {}, { scopeId: offScope, conversation: 'conv-c1' }), {
    message: refusal,
  });
  assert.equal(
    await executeMcpTool(SEARCH, { account: 'notion-2' }, { scopeId: offScope, conversation: 'conv-c2' }),
    'Error: No connected Notion account is "notion-2". Usable Notion accounts: notion. Pass one as `account`.'
  );
  assert.equal(b.keys.length, before, 'the switched-off account is never called');

  // One account: no `account` needed, the tool keeps its name.
  const solo = await accountServer(t, 'S');
  await connect(t, 'accounts-solo', { stripe: connectorServer('stripe', [['stripe', solo.url]]) });
  assert.deepEqual(
    getMcpTools('accounts-solo').map((tool) => tool.name),
    ['mcp__stripe__search']
  );
  assert.equal(
    await executeMcpTool('mcp__stripe__search', {}, { scopeId: 'accounts-solo', conversation: 'conv-s1' }),
    'S searched {}\n(Stripe account: stripe)'
  );
  assert.deepEqual(resolveMcpToolAccount('mcp__stripe__search', {}, { scopeId: 'accounts-solo' }), {
    name: 'stripe',
    label: 'stripe',
  });
});

/** An account server whose `work` keeps reporting progress (as an event
 *  stream) for `ms` before it answers, and whose `quiet` waits as long silently. */
async function progressServer(t, ms) {
  const sleep = (wait) => new Promise((resolve) => setTimeout(resolve, wait));
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const answer = (result) => ({ jsonrpc: '2.0', id: message.id, result });
      if (message.method !== 'tools/call') {
        res.setHeader('Content-Type', 'application/json');
        const result =
          message.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'p', version: '1' } }
            : {
                tools: ['work', 'quiet'].map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })),
              };
        res.end(JSON.stringify(answer(result)));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (payload) => res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      const token = message.params._meta?.progressToken;
      for (let elapsed = 0, step = 0; elapsed < ms; elapsed += 100, step += 1) {
        await sleep(100);
        if (message.params.name === 'work' && token !== undefined) {
          event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step } });
        }
      }
      event(answer({ content: [{ type: 'text', text: `${message.params.name} done` }] }));
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

test('an account’s progress resets the call’s deadline as a direct server’s does', async (t) => {
  const url = await progressServer(t, 900);
  const scopeId = 'accounts-progress';
  await connect(t, scopeId, {
    linear: { ...connectorServer('linear', [['linear', url]]), timeoutMs: 300 },
  });
  // Reporting progress past the 300ms deadline: it runs to its end.
  assert.equal(
    await executeMcpTool('mcp__linear__work', {}, { scopeId, conversation: 'conv-p1' }),
    'work done\n(Linear account: linear)'
  );
  // The same wait without progress is cut off at the deadline.
  await assert.rejects(executeMcpTool('mcp__linear__quiet', {}, { scopeId, conversation: 'conv-p1' }), {
    code: 'EMCPTOOLTIMEOUT',
  });
});

test('an approval stays bound to the account resolved when it was asked, whatever is used last meanwhile', async (t) => {
  const a = await accountServer(t, 'A');
  const b = await accountServer(t, 'B');
  const scopeId = 'accounts-approval';
  await connect(t, scopeId, {
    notion: connectorServer('notion', [
      ['notion', a.url],
      ['notion-2', b.url],
    ]),
  });
  await executeMcpTool(SEARCH, { account: 'notion-2' }, { scopeId, conversation: 'conv-other' });
  const asked = [];
  let meanwhile = '';
  const sessionRef = {
    mcpScopeId: scopeId,
    beforeToolHook: async () => ({ action: 'ask', reason: 'check' }),
    toolApprovalHook: async (request) => {
      asked.push(request);
      // While the card waits, another conversation uses the other account.
      await executeMcpTool(SEARCH, { account: 'notion' }, { scopeId, conversation: 'conv-other' });
      meanwhile = connectorAccountInUse('notion');
      return { approved: true };
    },
  };
  const result = await executeTool(SEARCH, { q: 3 }, process.cwd(), 'conv-bound', sessionRef, {});
  assert.equal(asked.length, 1);
  assert.equal(asked[0].account, 'notion-2', 'the card names the account');
  assert.equal(asked[0].args.account, 'notion-2');
  assert.equal(meanwhile, 'notion', 'the default moved while the card waited');
  assert.equal(String(result), 'B searched {"q":3}\n(Notion account: notion-2)', 'the approved account ran');

  // An account that cannot be used is refused before any hook or card sees the call.
  const refused = await executeTool(SEARCH, { account: 'nobody' }, process.cwd(), 'conv-bound', sessionRef, {});
  assert.match(
    String(refused),
    /^Error: No connected Notion account is "nobody"\. Usable Notion accounts: notion, notion-2\./
  );
  assert.equal(asked.length, 1);
});
