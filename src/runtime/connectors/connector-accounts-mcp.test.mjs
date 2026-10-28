// One MCP server per catalog connector: the union of its accounts' own tools,
// each with an optional `account`; a call goes to the account it names, else
// the one last used in its conversation, then the connector's last used, then
// the topmost; a named or remembered account that cannot be used fails closed
// with the usable ones listed; a conversation's call records its account and
// its result names it; an account that fails stays listed with why.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { accountsOfInstructions, connectorAccountsInstructions } from '../shared/connector-accounts.mjs';
import { connectorAccountServer, connectorAccountsUrl } from '../shared/connector-catalog.mjs';
import { hasConfiguredMcpAuth } from '../agent/orchestrator/mcp/client-transport.mjs';
import {
  CONVERSATION_META,
  connectorAccountHealth,
  connectorAccountInUse,
  forgetConnectorAccountHealth,
  withConnectorAccountsMcp,
} from './connector-accounts-mcp.mjs';

const A = 'a@example.com';
const B = 'b@example.com';
const object = (properties) => ({ type: 'object', properties });
const SEARCH = { name: 'search', description: 'Search', inputSchema: object({ query: { type: 'string' } }) };
const CREATE = { name: 'create', description: 'Create', inputSchema: object({ title: { type: 'string' } }) };

/** An account whose own server lists `tools` and records every call it gets. */
function fakeAccount(name, email, { tools = [SEARCH, CREATE], fail = null, instructions = '' } = {}) {
  const calls = [];
  return {
    calls,
    account: {
      name,
      email,
      async connect() {
        if (fail) throw fail;
        return { instructions, tools };
      },
      async callTool(params) {
        calls.push(params);
        if (fail) throw fail;
        return { content: [{ type: 'text', text: `${name} did ${params.name}` }] };
      },
      close() {},
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
  /** A tools/call, made in `conversation` when one is given. */
  const call = async (name, args = {}, conversation = '') => {
    const meta = conversation ? { _meta: { [CONVERSATION_META]: conversation } } : {};
    const { result } = await rpc('tools/call', { name, arguments: args, ...meta });
    return { ...result, text: result.content.map((part) => part.text).join('\n') };
  };
  return { fetchImpl, rpc, call };
}

test('a connector server never signs in itself: each account carries its own authentication', () => {
  const cfg = {
    type: 'http',
    url: connectorAccountsUrl('notion'),
    connector: 'notion',
    accounts: [{ name: 'notion', url: 'https://mcp.notion.com/mcp' }],
  };
  assert.equal(hasConfiguredMcpAuth(cfg), true);
  assert.equal(hasConfiguredMcpAuth(connectorAccountServer(cfg, cfg.accounts[0])), false, 'the account signs in');
  // Only a catalog connector's list counts.
  assert.equal(hasConfiguredMcpAuth({ ...cfg, connector: 'nope' }), false);
});

test('the instructions name the accounts in one line, and read back', () => {
  assert.equal(connectorAccountsInstructions([{ email: A }]), `Accounts: ${A}. \`account\` may be left out.`);
  const several = connectorAccountsInstructions([{ email: A }, { email: B, note: 'needs sign-in' }, { email: '' }]);
  assert.equal(
    several,
    `Accounts: ${A}, ${B} (needs sign-in). \`account\` picks one; left out, a call uses the account used last, and its result names it.`
  );
  assert.deepEqual(accountsOfInstructions(several), [A, B]);
  assert.equal(connectorAccountsInstructions([]), undefined);
});

test('one tool set: the union of what the accounts list, each with `account`; a tool whose schema differs is left out', async () => {
  const other = { ...CREATE, inputSchema: object({ title: { type: 'string' }, parent: { type: 'string' } }) };
  const extra = { name: 'export', description: 'Export', inputSchema: object({}) };
  const { rpc } = server('linear', [
    fakeAccount('linear', A, { instructions: 'Linear: search first.' }).account,
    fakeAccount('linear-2', B, { tools: [SEARCH, other, extra], instructions: 'Linear: search first.' }).account,
  ]);
  const init = await rpc('initialize');
  assert.equal(
    init.result.instructions,
    `Accounts: ${A}, ${B}. \`account\` picks one; left out, a call uses the account used last, and its result names it.\n\nLinear: search first.`
  );
  const { tools } = (await rpc('tools/list')).result;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['search', 'export']
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.properties.account.type, 'string', tool.name);
    assert.ok(!(tool.inputSchema.required || []).includes('account'), tool.name);
  }
  assert.deepEqual(tools[0].inputSchema.properties.query, { type: 'string' }, 'the backend schema is kept');
});

test('schemas that differ only in key order are one tool', async () => {
  const reordered = {
    ...SEARCH,
    inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
  };
  const { rpc } = server('airtable', [
    fakeAccount('airtable', A, { tools: [SEARCH] }).account,
    fakeAccount('airtable-2', B, { tools: [reordered] }).account,
  ]);
  await rpc('initialize');
  assert.deepEqual(
    (await rpc('tools/list')).result.tools.map((tool) => tool.name),
    ['search']
  );
});

test('two accounts sharing one address are bound and run by their unique names; the shared address picks none', async () => {
  const SAME = 'same@example.com';
  const a = fakeAccount('workspace-a', SAME);
  const b = fakeAccount('workspace-b', SAME);
  const { fetchImpl, rpc, call } = server('sentry', [a.account, b.account]);
  await rpc('initialize');
  // Bound by name, it executes on that account, and the note tells the two apart.
  assert.deepEqual(fetchImpl.connectorAccounts.choose({ tool: 'search', wanted: 'workspace-b', conversation: '' }), {
    name: 'workspace-b',
    label: `${SAME} (workspace-b)`,
  });
  assert.equal(
    (await call('search', { account: 'workspace-b' }, 'conv-same')).text,
    `workspace-b did search\n(Sentry account: ${SAME} (workspace-b))`
  );
  assert.deepEqual([a.calls.length, b.calls.length], [0, 1]);
  // Its label, as the note shows it, names it too.
  assert.match((await call('search', { account: `${SAME} (workspace-a)` }, 'conv-same')).text, /^workspace-a did/);
  // The shared address fails closed, listing them by name.
  const ambiguous = await call('search', { account: SAME }, 'conv-same');
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /^"same@example\.com" is more than one Sentry account \(workspace-a, workspace-b\); name one\./);
  assert.throws(
    () => fetchImpl.connectorAccounts.choose({ tool: 'search', wanted: SAME, conversation: '' }),
    /more than one Sentry account \(workspace-a, workspace-b\)/
  );
  assert.deepEqual([a.calls.length, b.calls.length], [1, 1], 'neither account ran it');
  forgetConnectorAccountHealth('workspace-a');
  forgetConnectorAccountHealth('workspace-b');
});

test('the account used: named, else the conversation’s last, else the connector’s last, else the topmost; naming one makes it the last used', async () => {
  const first = fakeAccount('notion', A);
  const second = fakeAccount('notion-2', B);
  const { rpc, call } = server('notion', [first.account, second.account]);
  await rpc('initialize');
  assert.equal(connectorAccountInUse('notion'), '');

  // Nothing used yet: the topmost account; the result names it.
  const top = await call('search', { query: 'x' }, 'conv-1');
  assert.equal(top.text, `notion did search\n(Notion account: ${A})`);
  assert.deepEqual(first.calls.at(-1), { name: 'search', arguments: { query: 'x' } }, '`account` is never forwarded');

  // Naming the other account (by address, any case) uses it and makes it the last used.
  assert.equal(
    (await call('search', { account: ' B@Example.com ' }, 'conv-1')).text,
    `notion-2 did search\n(Notion account: ${B})`
  );
  assert.deepEqual(second.calls.at(-1), { name: 'search', arguments: {} });
  assert.equal(connectorAccountInUse('notion'), 'notion-2');
  assert.match((await call('search', {}, 'conv-1')).text, /^notion-2 did/, 'the conversation keeps it');
  // Another conversation without its own starts from the connector's last used.
  assert.match((await call('search', {}, 'conv-2')).text, /^notion-2 did/);
  // Naming by account name; that conversation and the connector move to it.
  assert.match((await call('search', { account: 'notion' }, 'conv-2')).text, /^notion did/);
  assert.equal(connectorAccountInUse('notion'), 'notion');
  assert.match(
    (await call('search', {}, 'conv-1')).text,
    /^notion-2 did/,
    'a conversation’s own last used comes first'
  );
  // Every conversation's call makes its account the connector's last used.
  assert.equal(connectorAccountInUse('notion'), 'notion-2');
  assert.match((await call('search', {}, 'conv-3')).text, /^notion-2 did/);
  await call('search', { account: A }, 'conv-3');
  // A call outside any conversation uses the connector's last used and records nothing.
  assert.equal((await call('search')).text, `notion did search\n(Notion account: ${A})`);
  assert.equal((await call('search', { account: B })).text, `notion-2 did search\n(Notion account: ${B})`);
  assert.equal(connectorAccountInUse('notion'), 'notion');
  // The binding seam answers the same choice without recording anything.
  const { connectorAccounts } = server('notion', [first.account, second.account]).fetchImpl;
  assert.equal(connectorAccounts.connector, 'notion');
  assert.deepEqual(connectorAccounts.choose({ tool: 'search', wanted: '', conversation: 'conv-1' }), {
    name: 'notion-2',
    label: B,
  });
  assert.deepEqual(connectorAccounts.choose({ tool: 'search', wanted: '', conversation: 'conv-9' }), {
    name: 'notion',
    label: A,
  });
  assert.equal(connectorAccountInUse('notion'), 'notion');
});

test('a named or remembered account that cannot be used fails closed with the usable accounts listed', async () => {
  const signIn = Object.assign(new Error('Sign-in required; sign this account in again in Connectors.'), {
    authRequired: true,
  });
  const good = fakeAccount('jira', A, { tools: [SEARCH] });
  const expired = fakeAccount('jira-2', B, { fail: signIn });
  const { rpc, call } = server('jira', [good.account, expired.account]);
  await rpc('initialize');
  const refusal = (why) => `${why} Usable Jira accounts: ${A}. Pass one as \`account\`.`;

  const unknown = await call('search', { account: 'c@example.com' }, 'conv-j1');
  assert.equal(unknown.isError, true);
  assert.equal(unknown.text, refusal('No connected Jira account is "c@example.com".'));
  const needsSignIn = await call('search', { account: 'jira-2' }, 'conv-j1');
  assert.equal(needsSignIn.text, refusal(`${B} needs a sign-in in Connectors.`));
  assert.deepEqual(expired.calls, [], 'the account that cannot be used is never called');
  assert.deepEqual(good.calls, [], 'and no other account stands in');

  // A listed tool the chosen account does not have.
  const narrow = fakeAccount('trello', A, { tools: [SEARCH] });
  const wide = fakeAccount('trello-2', B);
  const trello = server('trello', [narrow.account, wide.account]);
  await trello.rpc('initialize');
  const missing = await trello.call('create', {}, 'conv-t1');
  assert.equal(missing.text, `${A} has no create tool. Usable Trello accounts: ${A}, ${B}. Pass one as \`account\`.`);
  assert.deepEqual([narrow.calls, wide.calls], [[], []]);
  assert.match((await trello.call('create', { account: B }, 'conv-t1')).text, /^trello-2 did create/);

  // A remembered account that was switched off or removed (no longer among them).
  const both = server('confluence', [fakeAccount('confluence', A).account, fakeAccount('confluence-2', B).account]);
  await both.rpc('initialize');
  await both.call('search', { account: B }, 'conv-c1');
  const left = server('confluence', [fakeAccount('confluence', A).account]);
  await left.rpc('initialize');
  for (const conversation of ['conv-c1', 'conv-c2']) {
    const gone = await left.call('search', {}, conversation);
    assert.equal(gone.isError, true);
    assert.equal(
      gone.text,
      `The Confluence account used last (confluence-2) is not connected now. Usable Confluence accounts: ${A}. Pass one as \`account\`.`
    );
  }
  assert.throws(
    () => left.fetchImpl.connectorAccounts.choose({ tool: 'search', wanted: '', conversation: 'conv-c1' }),
    /used last \(confluence-2\) is not connected now/
  );
  for (const name of ['jira', 'jira-2', 'confluence', 'confluence-2', 'trello', 'trello-2']) {
    forgetConnectorAccountHealth(name);
  }
});

test('a failing account stays listed with why; the server fails only when no account works', async () => {
  const signIn = Object.assign(new Error('Sign-in required; sign this account in again in Connectors.'), {
    authRequired: true,
  });
  const broken = new Error('connect ECONNREFUSED');
  const good = fakeAccount('google-calendar', '', {
    instructions: connectorAccountsInstructions([{ email: A }]),
  });
  const bad = fakeAccount('google-calendar-2', '', { fail: signIn });
  const { rpc, call } = server('google-calendar', [good.account, bad.account]);
  const init = await rpc('initialize');
  // The address an in-process Google account names; one unknown until it answers is listed by name.
  assert.equal(
    init.result.instructions,
    `Accounts: ${A}, google-calendar-2 (needs sign-in). \`account\` picks one; left out, a call uses the account used last, and its result names it.`
  );
  assert.deepEqual(connectorAccountHealth('google-calendar'), { email: A, error: '', authRequired: false });
  assert.deepEqual(connectorAccountHealth('google-calendar-2'), {
    email: '',
    error: signIn.message,
    authRequired: true,
  });
  assert.equal(
    (await call('search', { account: A })).text,
    `google-calendar did search\n(Google Calendar account: ${A})`
  );

  // A call that fails names its account in the note, as one cancelled does, and records why.
  const flaky = fakeAccount('drive', A);
  const drive = server('google-drive', [flaky.account]);
  await drive.rpc('initialize');
  flaky.account.callTool = async () => Promise.reject(broken);
  const failed = await drive.call('search', {}, 'conv-d1');
  assert.equal(failed.isError, true);
  assert.equal(failed.text, `${broken.message}\n(Google Drive account: ${A})`);
  assert.equal(connectorAccountHealth('drive').error, broken.message);
  flaky.account.callTool = (_params, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const controller = new AbortController();
  const pending = drive.fetchImpl(connectorAccountsUrl('google-drive'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'search', arguments: {} } }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const cancelled = (await (await pending).json()).result;
  assert.equal(cancelled.isError, true);
  assert.deepEqual(
    cancelled.content.map((part) => part.text),
    ['cancelled', `(Google Drive account: ${A})`]
  );
  assert.equal(connectorAccountHealth('drive').error, broken.message, 'a cancel says nothing about health');

  const none = server('google-calendar', [fakeAccount('cal-x', B, { fail: signIn }).account]);
  const refused = await none.rpc('initialize');
  assert.equal(refused.error.message, signIn.message);
  for (const name of ['google-calendar', 'google-calendar-2', 'cal-x', 'drive']) forgetConnectorAccountHealth(name);
  assert.equal(connectorAccountHealth('cal-x'), null);
});
