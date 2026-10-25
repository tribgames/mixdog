// The connector catalog's runtime side: a catalog connect stores its marker on
// an ordinary user server, the status row carries it, and the setup tool's
// connect_connector surfaces a card without connecting anything.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTOR_CATALOG,
  CONNECTOR_IDS,
  GOOGLE_SCOPES,
  connectorById,
  connectorOfServer,
  connectorServerInput,
  connectorToolDefault,
} from '../runtime/shared/connector-catalog.mjs';
import { CONNECTOR_TRIGGERS, connectorTrigger } from '../runtime/shared/connector-triggers.mjs';
import { createMcpGlue } from './mcp-glue.mjs';
import { createResourceApi } from './resource-api.mjs';
import { createSetupToolExecutor } from './setup-tool/executor.mjs';

test('the catalog uses the curated deferred-tool ids and declares every backend', () => {
  // `github` keeps a trigger for user-added GitHub MCP servers but is not a catalog connector.
  assert.deepEqual(
    CONNECTOR_CATALOG.map((entry) => entry.id).sort(),
    Object.keys(CONNECTOR_TRIGGERS)
      .filter((id) => id !== 'github')
      .sort()
  );
  // Every Google connector is offered to everyone.
  assert.deepEqual(
    [...CONNECTOR_IDS].filter((id) => id === 'gmail' || id.startsWith('google-')),
    ['gmail', 'google-calendar', 'google-drive']
  );
  for (const entry of CONNECTOR_CATALOG) {
    assert.equal(entry.trigger, connectorTrigger(entry.id));
    assert.ok(['oauth', 'apiKey'].includes(entry.backend.kind), entry.id);
  }
  // The Google connectors are the built-in in-process server, signed in with
  // Mixdog's client and the one scope list per connector.
  for (const [id, service] of [
    ['gmail', 'gmail'],
    ['google-calendar', 'calendar'],
    ['google-drive', 'drive'],
  ]) {
    const { backend } = CONNECTOR_CATALOG.find((entry) => entry.id === id);
    assert.equal(backend.url, `https://${service}.mixdog.invalid/mcp`);
    assert.equal(backend.oauthClient, 'google');
    assert.equal(backend.scopes, GOOGLE_SCOPES[service]);
  }
  assert.deepEqual(GOOGLE_SCOPES.gmail.at(-1), 'https://www.googleapis.com/auth/gmail.send');
  assert.equal(connectorToolDefault('gmail', 'send_email'), 'needs_approval');
  assert.equal(connectorToolDefault('google-calendar', 'delete_event'), 'needs_approval');
  assert.equal(connectorToolDefault('google-calendar', 'list_events'), 'auto');
  assert.equal(connectorToolDefault('notion', 'anything'), 'auto');
  // GitHub is the signed-in GitHub CLI, not a connector.
  assert.equal(connectorById('github'), null);
  assert.deepEqual(
    connectorServerInput(
      CONNECTOR_CATALOG.find((entry) => entry.id === 'notion'),
      'notion'
    ),
    {
      name: 'notion',
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
      connector: 'notion',
    }
  );
  const stripe = connectorServerInput(
    CONNECTOR_CATALOG.find((entry) => entry.id === 'stripe'),
    'stripe',
    'rk_1'
  );
  assert.deepEqual(stripe.headers, { Authorization: 'Bearer rk_1' });
  // Postgres runs its local server with the connection string as its key.
  assert.deepEqual(
    connectorServerInput(
      CONNECTOR_CATALOG.find((entry) => entry.id === 'postgres'),
      'postgres',
      ' postgresql://u:p@h/db '
    ),
    {
      name: 'postgres',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@microsoft/postgres-mcp@0.2.0', 'run'],
      env: { POSTGRES_MCP_CONNECTION_STRING: 'postgresql://u:p@h/db' },
      connector: 'postgres',
    }
  );
  // Retired connectors (Figma, Unity, Slack, Blender) are gone from the catalog.
  for (const id of ['figma', 'unity', 'slack', 'blender']) {
    assert.equal(CONNECTOR_IDS.includes(id), false, id);
  }
  // A server saved with a retired marker, or one running a retired package or
  // URL, is no catalog service.
  assert.equal(connectorOfServer({ type: 'http', url: 'http://127.0.0.1:3845/mcp/' }), '');
  assert.equal(connectorOfServer({ type: 'stdio', command: 'uvx', args: ['--from', 'mcpforunityserver'] }), '');
  assert.equal(connectorOfServer({ type: 'stdio', command: 'uvx', args: ['mcp-for-blender'] }), '');
  assert.equal(
    connectorOfServer({ type: 'stdio', command: 'uvx', args: ['mcp-for-blender'], connector: 'blender' }),
    ''
  );
  assert.equal(
    connectorOfServer({ type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp-server@1.3.0'], connector: 'slack' }),
    ''
  );
  assert.throws(
    () =>
      connectorServerInput(
        CONNECTOR_CATALOG.find((entry) => entry.id === 'stripe'),
        'x'
      ),
    /needs a key/
  );
});

test('a catalog connect stores its marker; status rows carry it; a custom server stays unmarked', async (t) => {
  let config = { mcpServers: { notion: { type: 'http', url: 'https://example.com/my-notion' } } };
  const glue = createMcpGlue({ getConfig: () => config, getCurrentCwd: () => process.cwd(), mcpClient: {}, state: {} });
  const api = createResourceApi({
    getConfig: () => config,
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: (next) => {
      config = structuredClone(next);
    },
    connectConfiguredMcp: async () => ({ servers: [] }),
    invalidatePreSessionToolSurface: () => {},
    refreshEmptySessionToolPolicy: async () => {},
    recreateCurrentSessionIfReady: async () => {},
    normalizeMcpServerInput: glue.normalizeMcpServerInput,
    mcpStatus: () => glue.mcpStatus(),
    resolveMcpCatalog: glue.resolveMcpCatalog,
    pluginMcpServer: glue.pluginMcpServer,
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    getActiveTurnCount: () => 0,
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  const notion = CONNECTOR_CATALOG.find((entry) => entry.id === 'notion');
  await api.addMcpServer(connectorServerInput(notion, 'notion-2'));
  assert.equal(config.mcpServers['notion-2'].connector, 'notion');
  assert.equal(config.mcpServers.notion.connector, undefined, 'the existing custom Notion server is not adopted');
  await assert.rejects(
    api.addMcpServer({ name: 'x', url: 'https://x.test/mcp', connector: 'nope' }),
    /Unknown connector/
  );
  const rows = glue.mcpStatus().servers;
  assert.equal(rows.find((row) => row.name === 'notion-2').connector, 'notion');
  assert.equal(rows.find((row) => row.name === 'notion').connector, undefined);
});

test('a server saved for a retired connector keeps loading and working as a custom server', async (t) => {
  const legacy = {
    slack: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'slack-mcp-server@1.3.0', '--transport', 'stdio'],
      env: { SLACK_MCP_XOXP_TOKEN: 'xoxp-1' },
      connector: 'slack',
    },
    figma: { type: 'http', url: 'http://127.0.0.1:3845/mcp', connector: 'figma' },
    blender: { type: 'stdio', command: 'uvx', args: ['mcp-for-blender'], connector: 'blender' },
    unity: { type: 'stdio', command: 'uvx', args: ['--from', 'mcpforunityserver', 'mcp-for-unity'] },
  };
  let config = { mcpServers: structuredClone(legacy) };
  const glue = createMcpGlue({ getConfig: () => config, getCurrentCwd: () => process.cwd(), mcpClient: {}, state: {} });
  const rows = glue.mcpStatus().servers;
  for (const name of ['slack', 'figma', 'blender', 'unity']) {
    const row = rows.find((r) => r.name === name);
    assert.ok(row, `${name} is still listed`);
    assert.equal(row.connector, undefined, `${name} is no catalog link`);
    assert.equal(row.enabled, true);
  }
  const api = createResourceApi({
    getConfig: () => config,
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: {},
    mgr: {},
    hooks: {},
    saveConfigAndAdopt: (next) => {
      config = structuredClone(next);
    },
    connectConfiguredMcp: async () => ({ servers: [] }),
    invalidatePreSessionToolSurface: () => {},
    refreshEmptySessionToolPolicy: async () => {},
    recreateCurrentSessionIfReady: async () => {},
    normalizeMcpServerInput: glue.normalizeMcpServerInput,
    mcpStatus: () => glue.mcpStatus(),
    resolveMcpCatalog: glue.resolveMcpCatalog,
    pluginMcpServer: glue.pluginMcpServer,
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    getActiveTurnCount: () => 0,
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  // Editing it keeps its command and environment.
  await api.saveMcpServer({
    name: 'slack',
    originalName: 'slack',
    type: 'stdio',
    command: 'npx',
    args: legacy.slack.args,
  });
  assert.equal(config.mcpServers.slack.command, 'npx');
  assert.deepEqual(config.mcpServers.slack.env, legacy.slack.env);
  for (const name of ['figma', 'blender', 'unity']) assert.deepEqual(config.mcpServers[name], legacy[name]);
});

test('setup connect_connector reports state and never connects', async () => {
  const calls = [];
  const executor = createSetupToolExecutor({
    getApi: () =>
      new Proxy(
        { mcpStatus: () => ({ servers: [{ name: 'linear', connector: 'linear', connected: false }] }) },
        {
          get(target, key) {
            if (key in target) return target[key];
            return (...args) => calls.push([key, args]);
          },
        }
      ),
  });
  const result = JSON.parse(await executor.execute({ action: 'connect_connector', connector: 'linear' }));
  assert.equal(result.connector, 'linear');
  assert.equal(result.server, 'linear');
  assert.equal(result.connected, false);
  assert.match(result.note, /connect card/);
  assert.deepEqual(calls, []);
  await assert.rejects(executor.execute({ action: 'connect_connector', connector: 'myspace' }), /connector/);
  await assert.rejects(
    executor.execute({ action: 'connect_connector', connector: 'github' }),
    /GitHub uses the signed-in GitHub CLI; no connector needed/
  );
  assert.deepEqual(calls, []);
});
