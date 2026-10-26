// One MCP server per multi-account connector: one tool set whose `account`
// argument picks the account (default with one, a listed refusal with several
// and none named), each call reaching that account's own endpoint with its own
// credentials, and an account that fails staying listed with why.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountsOfInstructions, connectorAccountsInstructions } from '../shared/connector-accounts.mjs';
import { GMAIL_APP_PASSWORD, connectorAccountServer, connectorAccountsUrl } from '../shared/connector-catalog.mjs';
import { hasConfiguredMcpAuth } from '../agent/orchestrator/mcp/client-transport.mjs';
import {
  connectorAccountHealth,
  connectorAccountRequest,
  forgetConnectorAccountHealth,
  withConnectorAccountsMcp,
} from './connector-accounts-mcp.mjs';
import { gmailAppPasswordSecretAccount, withGmailAppPasswordMcp } from './gmail-app-password.mjs';

const A = 'a@gmail.com';
const B = 'b@gmail.com';

/** An account endpoint that records what it was asked. */
function fakeAccount(name, email, { fail = null, appPassword = true } = {}) {
  const seen = [];
  return {
    seen,
    account: {
      name,
      email: appPassword ? email : '',
      appPassword,
      async request(message) {
        seen.push(message);
        if (fail) throw fail;
        if (message.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: { instructions: connectorAccountsInstructions([{ email }]) },
          };
        }
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${email} did it` }] } };
      },
    },
  };
}

function server(connector, accounts) {
  const fetchImpl = withConnectorAccountsMcp({ connector, accounts });
  const rpc = async (method, params = {}) => {
    const response = await fetchImpl(connectorAccountsUrl(connector), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    });
    return response.json();
  };
  const call = async (name, args) => {
    const { result } = await rpc('tools/call', { name, arguments: args });
    return { ...result, text: result.content.map((part) => part.text).join('\n') };
  };
  return { fetchImpl, rpc, call };
}

test('a connector server never signs in itself: each account carries its own authentication', () => {
  const cfg = {
    type: 'http',
    url: connectorAccountsUrl('google-calendar'),
    connector: 'google-calendar',
    accounts: [{ name: 'google-calendar', url: 'https://calendar.mixdog.invalid/mcp' }],
  };
  assert.equal(hasConfiguredMcpAuth(cfg), true);
  assert.equal(hasConfiguredMcpAuth(connectorAccountServer(cfg, cfg.accounts[0])), false, 'the account signs in');
  // Only a multi-account catalog connector's list counts.
  assert.equal(hasConfiguredMcpAuth({ ...cfg, connector: 'notion' }), false);
});

test('the instructions name the accounts in one line, and read back', () => {
  assert.equal(connectorAccountsInstructions([{ email: A }]), `Accounts: ${A}. \`account\` may be left out.`);
  const several = connectorAccountsInstructions([{ email: A }, { email: B, note: 'needs sign-in' }, { email: '' }]);
  assert.equal(
    several,
    `Accounts: ${A}, ${B} (needs sign-in). Pass \`account\`; if the user named none and there are several, ask which.`
  );
  assert.deepEqual(accountsOfInstructions(several), [A, B]);
  assert.equal(connectorAccountsInstructions([]), undefined);
});

test('one tool set for every account: each tool takes `account`, none names an address', async () => {
  const { rpc } = server('gmail', [fakeAccount('gmail', A).account, fakeAccount('gmail-2', B).account]);
  const init = await rpc('initialize');
  assert.equal(
    init.result.instructions,
    `Accounts: ${A}, ${B}. Pass \`account\`; if the user named none and there are several, ask which.`
  );
  const { tools } = (await rpc('tools/list')).result;
  assert.ok(tools.some((tool) => tool.name === 'search_emails'));
  assert.ok(!tools.some((tool) => tool.name === 'describe_emails'), 'the approval-only tool stays unlisted');
  for (const tool of tools) {
    assert.equal(tool.inputSchema.properties.account.type, 'string', tool.name);
    assert.ok(!(tool.inputSchema.required || []).includes('account'), tool.name);
    assert.doesNotMatch(tool.description, /@gmail\.com/);
  }
  // A Google sign-in connector lists its own service's tools.
  const calendar = server('google-calendar', [fakeAccount('google-calendar', A, { appPassword: false }).account]);
  const names = (await calendar.rpc('tools/list')).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['list_events', 'create_event', 'update_event', 'delete_event']);
});

test('account selection: the only account by default; several need one named, and the refusal lists them', async () => {
  const one = fakeAccount('gmail', A);
  const single = server('gmail', [one.account]);
  await single.rpc('initialize');
  assert.equal((await single.call('search_emails', { query: 'x' })).text, `${A} did it`);
  assert.deepEqual(one.seen.at(-1).params, { name: 'search_emails', arguments: { query: 'x' } });

  const first = fakeAccount('gmail', A);
  const second = fakeAccount('gmail-2', B);
  const both = server('gmail', [first.account, second.account]);
  await both.rpc('initialize');
  const unnamed = await both.call('search_emails', { query: 'x' });
  assert.equal(unnamed.isError, true);
  assert.equal(
    unnamed.text,
    `Several Gmail accounts are connected: ${A}, ${B}. Ask the user which one, then pass it as \`account\`.`
  );
  assert.equal(first.seen.length + second.seen.length, 2, 'nothing but the initializes was sent');

  const named = await both.call('archive_emails', { ids: ['1'], account: ' B@Gmail.com ' });
  assert.equal(named.text, `${B} did it`);
  assert.deepEqual(
    second.seen.at(-1).params,
    { name: 'archive_emails', arguments: { ids: ['1'] } },
    '`account` is not forwarded'
  );
  assert.equal(first.seen.length, 1, 'the other account is never asked');
  // The account name works too; an unknown one is refused with the list.
  assert.equal((await both.call('search_emails', { account: 'gmail' })).text, `${A} did it`);
  const unknown = await both.call('search_emails', { account: 'c@gmail.com' });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.text, `Unknown Gmail account "c@gmail.com". Accounts: ${A}, ${B}.`);
  // The approval gate's unlisted tool takes `account` the same way.
  assert.equal((await both.call('describe_emails', { account: A })).text, `${A} did it`);
});

test('a failing account stays listed with why; the server fails only when no account works', async () => {
  const signIn = Object.assign(new Error('Sign-in required; sign this account in again in Connectors.'), {
    authRequired: true,
  });
  const good = fakeAccount('google-calendar', A, { appPassword: false });
  const bad = fakeAccount('google-calendar-2', B, { appPassword: false, fail: signIn });
  const { rpc, call } = server('google-calendar', [good.account, bad.account]);
  const init = await rpc('initialize');
  // An OAuth account whose address is unknown until it answers is listed by name.
  assert.equal(
    init.result.instructions,
    `Accounts: ${A}, google-calendar-2 (needs sign-in). Pass \`account\`; if the user named none and there are several, ask which.`
  );
  assert.deepEqual(connectorAccountHealth('google-calendar'), { email: A, error: '', authRequired: false });
  assert.deepEqual(connectorAccountHealth('google-calendar-2'), {
    email: '',
    error: signIn.message,
    authRequired: true,
  });
  const failed = await call('list_events', { account: 'google-calendar-2' });
  assert.equal(failed.isError, true);
  assert.equal(failed.text, `google-calendar-2: ${signIn.message}`);
  assert.equal((await call('list_events', { account: A })).text, `${A} did it`);

  const none = server('google-calendar', [fakeAccount('cal-x', B, { appPassword: false, fail: signIn }).account]);
  const refused = await none.rpc('initialize');
  assert.equal(refused.error.message, signIn.message);
  for (const name of ['google-calendar', 'google-calendar-2', 'cal-x']) forgetConnectorAccountHealth(name);
  assert.equal(connectorAccountHealth('cal-x'), null);
});

test('each account calls Gmail with its own app password, through the real MCP client', async (t) => {
  const store = new Map([
    [gmailAppPasswordSecretAccount(A), 'aaaaaaaaaaaaaaaa'],
    [gmailAppPasswordSecretAccount(B), 'bbbbbbbbbbbbbbbb'],
  ]);
  const credentialStore = { getSecretAsync: async (key) => store.get(key) ?? null };
  const logins = [];
  const imap = async (ctx) => {
    logins.push([ctx.email, ctx.password]);
    return {
      connect: async () => {},
      list: async () => [{ path: '[Gmail]/All Mail', specialUse: '\\All' }],
      mailboxOpen: async () => {},
      search: async () => [],
      logout: async () => {},
    };
  };
  const inner = withGmailAppPasswordMcp({ credentialStore, clients: { imap } }, () => {
    throw new Error('nothing leaves for the network');
  });
  const accountOf = (name, email) => ({
    name,
    email,
    appPassword: true,
    request: connectorAccountRequest(GMAIL_APP_PASSWORD.url, inner, { [GMAIL_APP_PASSWORD.accountHeader]: email }),
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connectorAccountsUrl('gmail')), {
      fetch: withConnectorAccountsMcp({
        connector: 'gmail',
        accounts: [accountOf('gmail', A), accountOf('gmail-2', B)],
      }),
    })
  );
  t.after(() => client.close());
  assert.match(client.getInstructions(), new RegExp(`^Accounts: ${A}, ${B}\\. `));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  await client.callTool({ name: 'search_emails', arguments: { account: B } });
  await client.callTool({ name: 'search_emails', arguments: { account: A } });
  assert.deepEqual(logins, [
    [B, 'bbbbbbbbbbbbbbbb'],
    [A, 'aaaaaaaaaaaaaaaa'],
  ]);
  for (const name of ['gmail', 'gmail-2']) forgetConnectorAccountHealth(name);
});
