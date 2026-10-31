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
  accountIdsDeps,
  connectorAccountHealth,
  connectorAccountInUse,
  ensureConnectorAccountIds,
  forgetConnectorAccountHealth,
  withConnectorAccountsMcp,
} from './connector-accounts-mcp.mjs';

const A = 'a@example.com';
const B = 'b@example.com';
const object = (properties) => ({ type: 'object', properties });
const SEARCH = { name: 'search', description: 'Search', inputSchema: object({ query: { type: 'string' } }) };
const CREATE = { name: 'create', description: 'Create', inputSchema: object({ title: { type: 'string' } }) };

/** An account whose own server lists `tools` and records every call it gets. */
// Its identity defaults to its name and address: the same pair is the same account.
function fakeAccount(name, email, { tools = [SEARCH, CREATE], fail = null, instructions = '', id = `${name}|${email}` } = {}) {
  const calls = [];
  return {
    calls,
    account: {
      name,
      id,
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

test('a remembered account is its identity: a new account given its name is never used for it, whatever the shared record says', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolvePluginData } = await import('../shared/plugin-paths.mjs');
  const inUseFile = join(resolvePluginData(), 'connector-accounts-in-use.json');
  const both = server('linear', [fakeAccount('linear', A).account, fakeAccount('linear-2', B).account]);
  await both.rpc('initialize');
  await both.call('search', { account: B }, 'conv-l1');
  // linear-2 is removed and a new account is given its name.
  const reused = fakeAccount('linear-2', 'new@example.com', { id: 'added-later' });
  const after = server('linear', [fakeAccount('linear', A).account, reused.account]);
  await after.rpc('initialize');
  const refused = /used last \(linear-2 \(removed\)\) is not connected now/;
  // The shared record reset, rewritten by hand, or naming the old identity:
  // the conversation's own choice still refuses, every time.
  for (const stored of [{}, { linear: 'linear-2' }, { linear: { name: 'linear-2', id: 'linear-2|b@example.com' } }]) {
    writeFileSync(inUseFile, JSON.stringify(stored));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const call = await after.call('search', {}, 'conv-l1');
      assert.equal(call.isError, true, JSON.stringify(stored));
      assert.match(call.text, refused);
    }
  }
  // A conversation with no choice of its own follows the shared record only to
  // the account it names: an old identity or none at all is refused.
  writeFileSync(inUseFile, JSON.stringify({ linear: { name: 'linear-2', id: 'linear-2|b@example.com' } }));
  assert.match((await after.call('search', {}, 'conv-l2')).text, refused);
  // A record without an identity is refused.
  writeFileSync(inUseFile, JSON.stringify({ linear: 'linear-2' }));
  assert.match((await after.call('search', {}, 'conv-l3')).text, /used last \(linear-2\) cannot be confirmed/);
  assert.deepEqual(reused.calls, [], 'the new account is never called in the old one’s place');
  // Picked explicitly, it becomes the conversation's account.
  assert.match((await after.call('search', { account: 'new@example.com' }, 'conv-l1')).text, /^linear-2 did search/);
  assert.match((await after.call('search', {}, 'conv-l1')).text, /^linear-2 did search/, 'chosen again, it is used');
  for (const name of ['linear', 'linear-2']) forgetConnectorAccountHealth(name);
});

test('the one-time identity migration binds the records of before, keeps every id, and serializes with choices', async () => {
  const { spawn } = await import('node:child_process');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolvePluginData } = await import('../shared/plugin-paths.mjs');
  const { readSection, updateSection } = await import('../shared/config.mjs');
  const inUseFile = join(resolvePluginData(), 'connector-accounts-in-use.json');
  const accountsServer = (connector, names) => ({
    type: 'http',
    url: connectorAccountsUrl(connector),
    connector,
    accounts: names.map((name) => ({ name, url: `https://${connector}.example.test/${name}` })),
  });
  const stored = (connector) => readSection('agent').mcpServers[connector].accounts;
  // The transport the stored accounts make: each with its stored identity.
  const transport = async (connector, calls = {}) => {
    const live = server(
      connector,
      stored(connector).map((one) => {
        const fake = fakeAccount(one.name, `${one.name}@example.com`, { id: one.id ?? '' });
        calls[one.name] = fake.calls;
        return fake.account;
      })
    );
    await live.rpc('initialize');
    return live;
  };
  // Before the upgrade: accounts without ids, records of names only.
  updateSection('agent', (agent) => ({
    ...agent,
    mcpServers: { linear: accountsServer('linear', ['linear', 'linear-2']), notion: accountsServer('notion', ['notion']) },
  }));
  writeFileSync(inUseFile, JSON.stringify({ linear: 'linear-2', notion: 'notion' }));
  // Two processes start at once while a third records a newer choice.
  const module = JSON.stringify(new URL('./connector-accounts-mcp.mjs', import.meta.url).href);
  const atomic = JSON.stringify(new URL('../shared/atomic-file.mjs', import.meta.url).href);
  const run = (body) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', body], {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
  const migrate = `const { ensureConnectorAccountIds } = await import(${module}); ensureConnectorAccountIds();`;
  const choose = `const { updateJsonAtomicSync } = await import(${atomic});
    updateJsonAtomicSync(${JSON.stringify(inUseFile)}, (s) => ({ ...s, notion: { name: 'notion', id: 'chosen-meanwhile' } }));`;
  await Promise.all([run(migrate), run(migrate), run(choose)]);
  const [linear, linear2] = stored('linear');
  assert.ok(linear.id && linear2.id && linear.id !== linear2.id, 'every account has its own id');
  const records = JSON.parse(readFileSync(inUseFile, 'utf8'));
  assert.deepEqual(records.linear, { name: 'linear-2', id: linear2.id }, 'the record of before is bound');
  assert.deepEqual(records.notion, { name: 'notion', id: 'chosen-meanwhile' }, 'the newer choice survives');
  // Bound, it routes where it did before the upgrade.
  assert.match((await (await transport('linear')).call('search', {}, 'conv-m1')).text, /^linear-2 did search/);
  // Another start, and an edit of the account (its transport): the identity stays.
  await run(migrate);
  updateSection('agent', (agent) => {
    const cfg = agent.mcpServers.linear;
    const accounts = cfg.accounts.map((one) => (one.name === 'linear-2' ? { ...one, url: `${one.url}/v2` } : one));
    return { ...agent, mcpServers: { ...agent.mcpServers, linear: { ...cfg, accounts } } };
  });
  await run(migrate);
  assert.equal(stored('linear')[1].id, linear2.id);
  assert.match((await (await transport('linear')).call('search', {}, 'conv-m2')).text, /^linear-2 did search/);
  // linear-2 removed and written again by hand, name and connection the same:
  // it is a new account (a new id on load), never the one remembered.
  updateSection('agent', (agent) => {
    const cfg = agent.mcpServers.linear;
    const accounts = cfg.accounts.map((one) => (one.name === 'linear-2' ? { name: one.name, url: one.url } : one));
    return { ...agent, mcpServers: { ...agent.mcpServers, linear: { ...cfg, accounts } } };
  });
  await run(migrate);
  assert.notEqual(stored('linear')[1].id, linear2.id);
  const calls = {};
  const recreated = await transport('linear', calls);
  for (const conversation of ['conv-m1', 'conv-m3']) {
    assert.match(
      (await recreated.call('search', {}, conversation)).text,
      /used last \(linear-2 \(removed\)\) is not connected now/
    );
  }
  // A name-only record found after the migration stays unbound.
  writeFileSync(inUseFile, JSON.stringify({ ...JSON.parse(readFileSync(inUseFile, 'utf8')), linear: 'linear' }));
  await run(migrate);
  assert.equal(JSON.parse(readFileSync(inUseFile, 'utf8')).linear, 'linear');
  assert.match((await recreated.call('search', {}, 'conv-m4')).text, /used last \(linear\) cannot be confirmed/);
  assert.deepEqual(calls, { linear: [], 'linear-2': [] }, 'no account stood in');
  for (const name of ['linear', 'linear-2', 'notion']) forgetConnectorAccountHealth(name);
  writeFileSync(inUseFile, '{}');
  updateSection('agent', ({ mcpServers: _servers, ...agent }) => agent);
});

test('the migration binds a record of before to the account its ids were given to, not one replacing it meanwhile', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolvePluginData } = await import('../shared/plugin-paths.mjs');
  const { readSection, updateSection } = await import('../shared/config.mjs');
  const inUseFile = join(resolvePluginData(), 'connector-accounts-in-use.json');
  const url = (name) => `https://linear.example.test/${name}`;
  updateSection('agent', (agent) => ({
    ...agent,
    mcpServers: {
      linear: {
        type: 'http',
        url: connectorAccountsUrl('linear'),
        connector: 'linear',
        accounts: ['linear', 'linear-2'].map((name) => ({ name, url: url(name) })),
      },
    },
  }));
  writeFileSync(inUseFile, JSON.stringify({ linear: 'linear-2' }));
  // Right after the ids are given, another process removes linear-2 and adds
  // a replacement under the same name (same connection, its own id).
  let given = '';
  accountIdsDeps.afterIdsGiven = () => {
    updateSection('agent', (agent) => {
      const cfg = agent.mcpServers.linear;
      given = cfg.accounts[1].id;
      const accounts = [cfg.accounts[0], { name: 'linear-2', url: url('linear-2'), id: 'replacement' }];
      return { ...agent, mcpServers: { linear: { ...cfg, accounts } } };
    });
  };
  try {
    ensureConnectorAccountIds();
  } finally {
    accountIdsDeps.afterIdsGiven = () => {};
  }
  assert.ok(given && given !== 'replacement');
  assert.deepEqual(JSON.parse(readFileSync(inUseFile, 'utf8')).linear, { name: 'linear-2', id: given });
  const replacement = fakeAccount('linear-2', 'new@example.com', { id: 'replacement' });
  const live = server('linear', [
    fakeAccount('linear', A, { id: readSection('agent').mcpServers.linear.accounts[0].id }).account,
    replacement.account,
  ]);
  await live.rpc('initialize');
  assert.match((await live.call('search', {}, 'conv-r1')).text, /used last \(linear-2 \(removed\)\) is not connected now/);
  assert.deepEqual(replacement.calls, [], 'the replacement never takes the old choice');
  for (const name of ['linear', 'linear-2']) forgetConnectorAccountHealth(name);
  writeFileSync(inUseFile, '{}');
  updateSection('agent', ({ mcpServers: _servers, ...agent }) => agent);
});

test('a migration interrupted once the ids are stored completes at the next start with those ids', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolvePluginData } = await import('../shared/plugin-paths.mjs');
  const { readSection, updateSection } = await import('../shared/config.mjs');
  const inUseFile = join(resolvePluginData(), 'connector-accounts-in-use.json');
  updateSection('agent', (agent) => ({
    ...agent,
    mcpServers: {
      linear: {
        type: 'http',
        url: connectorAccountsUrl('linear'),
        connector: 'linear',
        accounts: ['linear', 'linear-2'].map((name) => ({ name, url: `https://linear.example.test/${name}` })),
      },
    },
  }));
  writeFileSync(inUseFile, JSON.stringify({ linear: 'linear-2' }));
  // The process dies between the config write (ids) and the records' write.
  accountIdsDeps.afterIdsGiven = () => {
    throw new Error('killed');
  };
  try {
    assert.throws(() => ensureConnectorAccountIds(), /killed/);
  } finally {
    accountIdsDeps.afterIdsGiven = () => {};
  }
  const ids = readSection('agent').mcpServers.linear.accounts.map((one) => one.id);
  assert.ok(ids.every(Boolean), 'the ids were stored');
  assert.deepEqual(JSON.parse(readFileSync(inUseFile, 'utf8')), { linear: 'linear-2' }, 'the records were not');
  // The next start keeps those ids and binds the records of before to them.
  assert.equal(ensureConnectorAccountIds(), false);
  assert.deepEqual(
    readSection('agent').mcpServers.linear.accounts.map((one) => one.id),
    ids
  );
  assert.deepEqual(JSON.parse(readFileSync(inUseFile, 'utf8')), {
    linear: { name: 'linear-2', id: ids[1] },
    '#ids': true,
  });
  writeFileSync(inUseFile, '{}');
  updateSection('agent', ({ mcpServers: _servers, ...agent }) => agent);
});

test('a conversation resumed after a restart keeps its own account, not the one another conversation used last', async () => {
  const accounts = () => [fakeAccount('notion', A).account, fakeAccount('notion-2', B).account];
  const before = server('notion', accounts());
  await before.rpc('initialize');
  await before.call('search', { account: B }, 'conv-p1');
  await before.call('search', { account: A }, 'conv-p2');
  // A restart: a fresh module instance, nothing kept in memory.
  const restarted = await import(`./connector-accounts-mcp.mjs?restart=${Date.now()}`);
  const after = async (list) => {
    const fetchImpl = restarted.withConnectorAccountsMcp({ connector: 'notion', accounts: list });
    const rpc = async (method, params = {}) =>
      (
        await fetchImpl(connectorAccountsUrl('notion'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json();
    await rpc('initialize');
    const { result } = await rpc('tools/call', {
      name: 'search',
      arguments: {},
      _meta: { [CONVERSATION_META]: 'conv-p1' },
    });
    return result.content.map((part) => part.text).join('\n');
  };
  assert.match(await after(accounts()), /^notion-2 did search/);
  // Still bound to its identity: a new account given that name is refused.
  const replaced = [fakeAccount('notion', A).account, fakeAccount('notion-2', B, { id: 'other' }).account];
  assert.match(await after(replaced), /used last \(notion-2 \(removed\)\) is not connected now/);
  for (const name of ['notion', 'notion-2']) forgetConnectorAccountHealth(name);
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolvePluginData } = await import('../shared/plugin-paths.mjs');
  for (const file of ['connector-accounts-in-use.json', 'connector-accounts-by-conversation.json']) {
    writeFileSync(join(resolvePluginData(), file), '{}');
  }
});

test('a conversation keeps its account however many others choose one, until its session is deleted', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { resolvePluginData } = await import('../shared/plugin-paths.mjs');
  const file = join(resolvePluginData(), 'connector-accounts-by-conversation.json');
  const inUseFile = join(resolvePluginData(), 'connector-accounts-in-use.json');
  const bob = fakeAccount('notion', A);
  const alice = fakeAccount('notion-2', B);
  const live = server('notion', [bob.account, alice.account]);
  await live.rpc('initialize');
  await live.call('search', { account: B }, 'conv-alice');
  // Thousands of later conversations, the newest on Bob's account.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  for (let index = 0; index < 2500; index += 1) {
    stored[`conv-other-${index}`] = { accounts: { notion: { name: 'notion', id: bob.account.id } } };
  }
  writeFileSync(file, JSON.stringify(stored));
  await live.call('search', { account: A }, 'conv-latest');
  assert.match((await live.call('search', {}, 'conv-alice')).text, /^notion-2 did search/, 'Alice stays on hers');
  // The session deleted: its binding goes with it (the session purge hook).
  await import('../../session-runtime/boot/providers.mjs');
  const { _runSessionPurgeHooks } = await import('../agent/orchestrator/session/store/session-observers.mjs');
  _runSessionPurgeHooks('conv-alice', { cwds: [] });
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(after, 'conv-alice'), false);
  assert.ok(Object.hasOwn(after, 'conv-latest'));
  for (const name of ['notion', 'notion-2']) forgetConnectorAccountHealth(name);
  writeFileSync(file, '{}');
  writeFileSync(inUseFile, '{}');
});

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
