import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createMcpGlue } from './mcp-glue.mjs';
import { createResourceApi } from './resource-api.mjs';
import { createPluginStatus } from './cwd-plugins/plugin-status.mjs';
import { createSetupToolExecutor } from './setup-tool/executor.mjs';
import { addPlugin, listRegisteredPlugins, pluginAdminStatus, setPluginEnabled } from './services/plugin-admin.mjs';
import { PLUGIN_MCP_NAME_MAX, pluginMcpServerBaseName, resolveMcpServerCatalog } from './mcp-glue/plugin-servers.mjs';
import { countSkillFiles, pluginManifest } from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';
import { applyConfigPatch, diffConfig } from '../runtime/shared/config-patch.mjs';
import * as realMcpClient from '../runtime/agent/orchestrator/mcp/client.mjs';

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const clone = (value) => structuredClone(value);

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** Registry + data dir + "disk" config shared by every runtime of a test. */
function workspace(t) {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-mcp-live-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  const shared = { base, dataDir, disk: {} };
  shared.plugin = (dirName, files) => {
    const root = join(base, 'plugins', dirName);
    for (const [rel, body] of Object.entries(files)) writeJson(join(root, ...rel.split('/')), body);
    return root;
  };
  shared.dir = (name) => {
    const path = join(base, 'projects', name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return shared;
}

/** A fake connection registry, scoped like the real one. */
function fakeClient() {
  const live = new Map();
  const log = [];
  const roots = new Map();
  const scope = (id) => {
    if (!live.has(id)) live.set(id, new Map());
    return live.get(id);
  };
  return {
    log,
    roots,
    servers: (id) => scope(id),
    resolveMcpTransportKind: (cfg) => (cfg.url ? 'http' : 'stdio'),
    getMcpServerStatus: (id) =>
      [...scope(id).keys()].map((name) => ({ name, connected: true, toolCount: 1, tools: [] })),
    async connectMcpServers(servers, { scopeId }) {
      for (const [name, cfg] of Object.entries(servers)) {
        if (cfg.enabled === false) continue;
        scope(scopeId).set(name, cfg);
        log.push(['connect', scopeId, name]);
      }
    },
    async reconnectSingleMcpServer(scopeId, name, cfg) {
      scope(scopeId).set(name, cfg);
      log.push(['connect', scopeId, name]);
      return true;
    },
    async disconnectMcpServer(name, { scopeId }) {
      if (scope(scopeId).delete(name)) log.push(['drop', scopeId, name]);
    },
    async disconnectAll({ scopeId }) {
      scope(scopeId).clear();
    },
    setMcpScopeRoot: (id, root) => roots.set(id, root),
  };
}

/** One session runtime: its own cwd, MCP scope, and config snapshot whose
 *  saves land on the shared disk as field patches (like config-lifecycle). */
function runtime(t, shared, client, { cwd, scopeId, mcpClient = client, clearMcpServerOAuth = async () => {} }) {
  const rt = { config: clone(shared.disk), cwd };
  const state = { mcpFailures: [], mcpConnectGeneration: 0, mcpConnectInFlight: null };
  const glue = createMcpGlue({
    mcpClient,
    getConfig: () => rt.config,
    getCurrentCwd: () => rt.cwd,
    getMcpScopeId: () => scopeId,
    getPluginDataDir: () => shared.dataDir,
    listPlugins: () => listRegisteredPlugins({ dataDir: shared.dataDir }),
    state,
  });
  const { pluginsStatus } = createPluginStatus({
    listRegisteredPlugins,
    pluginAdminStatus,
    pluginManifest,
    pluginMcpSummary: glue.pluginMcpSummary,
    countSkillFiles,
    clean,
    resolve,
    statSync,
    existsSync,
    cfgMod: { getPluginData: () => shared.dataDir },
  });
  let baseline = clone(rt.config);
  const api = createResourceApi({
    getConfig: () => rt.config,
    getSession: () => null,
    getCurrentCwd: () => rt.cwd,
    cfgMod: { getPluginData: () => shared.dataDir },
    hooks: {},
    saveConfigAndAdopt: (next) => {
      shared.disk = applyConfigPatch(shared.disk, diffConfig(baseline, next));
      rt.config = clone(next);
      baseline = clone(next);
    },
    reloadFullConfig: () => {
      rt.config = clone(shared.disk);
      baseline = clone(rt.config);
    },
    connectConfiguredMcp: glue.connectConfiguredMcp,
    clearMcpServerOAuth,
    invalidatePreSessionToolSurface: () => {},
    refreshEmptySessionToolPolicy: async () => {},
    normalizeMcpServerInput: glue.normalizeMcpServerInput,
    mcpStatus: glue.mcpStatus,
    getMcpServerConfig: glue.getMcpServerConfig,
    resolveMcpCatalog: glue.resolveMcpCatalog,
    resolveConfiguredMcpCatalog: glue.resolveConfiguredMcpCatalog,
    pluginMcpServer: glue.pluginMcpServer,
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus,
    invalidateSkills: () => {},
    awaitKeychainPrewarm: async () => {},
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  return {
    rt,
    glue,
    api,
    scopeId,
    connected: () => [...client.servers(scopeId).keys()].sort(),
    live: (name) => client.servers(scopeId).get(name),
    row: (name) => api.mcpStatus().servers.find((server) => server.name === name),
  };
}

const context7Files = (servers = { context7: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] } }) => ({
  '.mcp.json': { mcpServers: servers },
});
const toolsFiles = {
  'plugin.json': {
    name: 'tools',
    mcpServers: {
      a: { command: 'node', args: ['a.mjs'] },
      b: { type: 'http', url: 'https://tools.example.test/mcp' },
      local: { command: 'node', cwd: 'srv' },
      bad: { type: 'stdio' },
    },
  },
};

test('plugin server names are provider-safe, deterministic, and independent of the server count', () => {
  assert.equal(pluginMcpServerBaseName('context7-1a2b3c4d', 'context7'), 'plugin-context7');
  assert.equal(pluginMcpServerBaseName('context7-1a2b3c4d', 'Docs_Server'), 'plugin-context7-docs-server');
  const long = pluginMcpServerBaseName('a-really-long-plugin-identifier-name-0f0f0f0f', 'and_a_long_server_key');
  assert.ok(long.length <= PLUGIN_MCP_NAME_MAX);
  assert.equal(long, pluginMcpServerBaseName('a-really-long-plugin-identifier-name-0f0f0f0f', 'and_a_long_server_key'));
  for (const name of [long, pluginMcpServerBaseName('x__y-12345678', '__k__')]) {
    assert.match(name, /^[a-z0-9-]+$/);
    assert.doesNotMatch(name, /__/);
  }
});

test('servers appear from enabled plugins, follow each runtime cwd, and reconcile on peers', async (t) => {
  const shared = workspace(t);
  const client = fakeClient();
  const [cwdA, cwdB, cwdC] = ['a', 'b', 'c'].map(shared.dir);
  const one = runtime(t, shared, client, { cwd: cwdA, scopeId: 'one' });
  const two = runtime(t, shared, client, { cwd: cwdB, scopeId: 'two' });
  const context7Root = shared.plugin('context7', context7Files());
  const toolsRoot = shared.plugin('tools', toolsFiles);

  await one.api.addPlugin(context7Root);
  await one.api.addPlugin(toolsRoot);
  const expected = ['plugin-context7', 'plugin-tools-a', 'plugin-tools-b', 'plugin-tools-local'];
  assert.deepEqual(one.connected(), expected);
  assert.deepEqual(two.connected(), expected, 'the peer reconciled on receipt');
  // Nothing plugin-owned is written into the user's MCP list.
  assert.equal(shared.disk.mcpServers, undefined);

  // claude format, no cwd: each runtime's own session cwd.
  assert.equal(one.live('plugin-context7').cwd, cwdA);
  assert.equal(two.live('plugin-context7').cwd, cwdB);
  // Placeholders resolve to forward-slash paths on Windows; the env keeps the raw root.
  const slashRoot = process.platform === 'win32' ? context7Root.replace(/\\/g, '/') : context7Root;
  assert.equal(one.live('plugin-context7').args[0], `${slashRoot}/server.mjs`);
  assert.equal(one.live('plugin-context7').env.CLAUDE_PLUGIN_ROOT, context7Root);
  // mixdog format keeps the plugin root; an explicit relative cwd resolves against it.
  assert.equal(one.live('plugin-tools-a').cwd, toolsRoot);
  assert.equal(one.live('plugin-tools-local').cwd, join(toolsRoot, 'srv'));
  assert.equal(one.live('plugin-tools-b').cwd, undefined);
  // The plugin data dir exists once its servers connected.
  const context7Id = listRegisteredPlugins({ dataDir: shared.dataDir })[0].id;
  assert.ok(existsSync(join(shared.dataDir, 'plugins', 'data', context7Id)));

  // A cwd switch reconnects only the cwd-following server and moves the roots.
  client.log.length = 0;
  one.rt.cwd = cwdC;
  await one.glue.connectConfiguredMcp({ reconcile: true });
  assert.deepEqual(client.log, [['connect', 'one', 'plugin-context7']]);
  assert.equal(one.live('plugin-context7').cwd, cwdC);
  assert.equal(client.roots.get('one'), cwdC);
  assert.equal(two.live('plugin-context7').cwd, cwdB);

  // Mixed declarations: the invalid one is reported, the valid ones run.
  const status = one.api.mcpStatus();
  assert.deepEqual(
    status.declarationErrors.map((error) => [error.key, error.message]),
    [['bad', 'stdio server requires "command"']]
  );
  const toolsRow = one.api.pluginsStatus().plugins.find((plugin) => plugin.name === 'tools');
  assert.deepEqual(
    toolsRow.mcpServers.map((server) => [server.name, server.key]),
    [
      ['plugin-tools-a', 'a'],
      ['plugin-tools-b', 'b'],
      ['plugin-tools-local', 'local'],
    ]
  );
  assert.equal(toolsRow.mcpErrors[0].key, 'bad');
  assert.equal(toolsRow.mcpServerName, 'plugin-tools-a');
  assert.equal(toolsRow.mcpEnabled, true);
  assert.equal(toolsRow.mcpInline, true);
  const context7Row = one.api.pluginsStatus().plugins.find((plugin) => plugin.id === context7Id);
  assert.equal(context7Row.mcpScript, '.mcp.json');
  assert.equal(context7Row.mcpServers[0].cwdDependent, true);
});

test('plugin and server toggles combine, update keeps names, remove drops servers everywhere', async (t) => {
  const shared = workspace(t);
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  const two = runtime(t, shared, client, { cwd: shared.dir('b'), scopeId: 'two' });
  const context7Root = shared.plugin('context7', context7Files());
  const toolsRoot = shared.plugin('tools', toolsFiles);
  await one.api.addPlugin(context7Root);
  await one.api.addPlugin(toolsRoot);

  // Plugin off: its servers drop here and on the peer, still listed with a reason.
  await one.api.setPluginEnabled('tools', false);
  assert.deepEqual(one.connected(), ['plugin-context7']);
  assert.deepEqual(two.connected(), ['plugin-context7']);
  assert.equal(one.row('plugin-tools-a').status, 'disabled');
  assert.equal(one.row('plugin-tools-a').disabledReason, 'plugin disabled');

  // A server toggle never bypasses the disabled plugin.
  await one.api.setMcpServerEnabled('plugin-tools-a', true);
  assert.deepEqual(two.connected(), ['plugin-context7']);
  await one.api.setMcpServerEnabled('plugin-tools-a', false);
  assert.deepEqual(shared.disk.pluginMcp, { [one.row('plugin-tools-a').owner.id]: { a: { enabled: false } } });

  // Plugin on again: the server the user turned off stays off.
  await one.api.setPluginEnabled('tools', true);
  assert.deepEqual(one.connected(), ['plugin-context7', 'plugin-tools-b', 'plugin-tools-local']);
  assert.deepEqual(two.connected(), ['plugin-context7', 'plugin-tools-b', 'plugin-tools-local']);
  assert.equal(one.row('plugin-tools-a').disabledReason, 'server disabled');
  await one.api.setMcpServerEnabled('plugin-tools-a', true);
  assert.ok(one.connected().includes('plugin-tools-a'));
  assert.ok(two.connected().includes('plugin-tools-a'));
  assert.deepEqual(shared.disk.pluginMcp || {}, {});

  // Update: a second declared server keeps the first one's name and connection.
  writeJson(
    join(context7Root, '.mcp.json'),
    context7Files({
      context7: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] },
      second: { command: 'node', args: ['second.mjs'] },
    })['.mcp.json']
  );
  client.log.length = 0;
  await one.api.updatePlugin('context7');
  assert.deepEqual(client.log, [
    ['connect', 'one', 'plugin-context7-second'],
    ['connect', 'two', 'plugin-context7-second'],
  ]);
  assert.ok(one.connected().includes('plugin-context7'));

  // Remove: gone here and on the peer, and its intent with it.
  await one.api.setMcpServerEnabled('plugin-context7-second', false);
  await one.api.removePlugin('context7');
  assert.deepEqual(one.connected(), ['plugin-tools-a', 'plugin-tools-b', 'plugin-tools-local']);
  assert.deepEqual(two.connected(), ['plugin-tools-a', 'plugin-tools-b', 'plugin-tools-local']);
  assert.deepEqual(shared.disk.pluginMcp || {}, {});
});

test('ordinary MCP edits refuse plugin servers; set_extension_scope still applies with plugin inheritance', async (t) => {
  const shared = workspace(t);
  const client = fakeClient();
  const cwd = shared.dir('a');
  const one = runtime(t, shared, client, { cwd, scopeId: 'one' });
  await one.api.addPlugin(shared.plugin('context7', context7Files()));
  await assert.rejects(
    one.api.addMcpServer({ name: 'plugin-context7', command: 'x' }),
    /already exists.*provided by plugin/
  );
  await assert.rejects(one.api.saveMcpServer({ name: 'plugin-context7', command: 'x' }), /provided by plugin/);
  await assert.rejects(
    one.api.saveMcpServer({ originalName: 'plugin-context7', name: 'renamed' }),
    /provided by plugin/
  );
  await assert.rejects(one.api.removeMcpServer('plugin-context7'), /provided by plugin/);
  assert.equal(shared.disk.mcpServers, undefined);
  const detail = one.api.getMcpServerConfig('plugin-context7');
  assert.equal(detail.source, 'plugin');
  assert.equal(detail.readOnly, true);
  assert.equal(detail.config._mixdogPlugin, undefined);

  const other = shared.dir('other');
  await one.api.setExtensionScope('plugins', 'context7', [other]);
  const row = one.row('plugin-context7');
  assert.deepEqual(row.inheritedScope, [other]);
  assert.equal(row.activeHere, false);
  await one.api.setExtensionScope('plugins', 'context7', []);
  // "Only in this project" for a connector is gone: projects switch it off instead.
  await assert.rejects(one.api.setExtensionScope('mcp', 'plugin-context7', [cwd]), /switched off per project/);
  assert.equal(one.row('plugin-context7').activeHere, true);
  // Reconnect works by name for a plugin server.
  client.log.length = 0;
  await one.api.reconnectMcp('plugin-context7');
  assert.deepEqual(client.log, [['connect', 'one', 'plugin-context7']]);
});

test('name collisions: a configured server keeps its name, later plugins get a deterministic suffix', async (t) => {
  const shared = workspace(t);
  shared.disk = { mcpServers: { 'plugin-context7': { command: 'mine' } } };
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  await one.api.addPlugin(shared.plugin('context7', context7Files()));
  const firstDup = shared.plugin(join('x', 'dup'), { '.mcp.json': { dup: { command: 'node' } } });
  const secondDup = shared.plugin(join('y', 'dup'), { '.mcp.json': { dup: { command: 'node' } } });
  await one.api.addPlugin(firstDup);
  await one.api.addPlugin(secondDup);
  const status = one.api.mcpStatus();
  const byName = Object.fromEntries(status.servers.map((server) => [server.name, server]));
  assert.equal(byName['plugin-context7'].source, 'config');
  const pluginCtx7 = status.servers.find((server) => server.owner?.key === 'context7');
  assert.match(pluginCtx7.name, /^plugin-context7-[0-9a-f]{6}$/);
  assert.match(pluginCtx7.warnings[0], /taken by a configured MCP server/);
  const dups = status.servers.filter((server) => server.owner?.key === 'dup');
  assert.equal(dups[0].name, 'plugin-dup');
  assert.match(dups[1].name, /^plugin-dup-[0-9a-f]{6}$/);
  assert.match(dups[1].warnings[0], /taken by plugin "dup-/);
  // Deterministic: resolving again yields the same names.
  assert.deepEqual(
    one.api.mcpStatus().servers.map((server) => server.name),
    status.servers.map((server) => server.name)
  );
  assert.equal(shared.disk.mcpServers['plugin-context7'].command, 'mine');
});

test('copies from the old enable action migrate once, keeping names, state, scopes, and credentials', async (t) => {
  const shared = workspace(t);
  const root = shared.plugin('legacy', {
    '.mcp.json': {
      main: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/main.mjs'] },
      extra: { type: 'http', url: 'https://legacy.example.test/mcp' },
    },
  });
  addPlugin(root, { dataDir: shared.dataDir });
  const id = listRegisteredPlugins({ dataDir: shared.dataDir })[0].id;
  const scopeRoot = shared.dir('scoped');
  const marker = { MIXDOG_PLUGIN_ROOT: root, MIXDOG_PLUGIN_DATA: join(shared.dataDir, 'plugins', 'data', id) };
  shared.disk = {
    mcpServers: {
      'plugin-legacy--main': {
        command: 'node',
        args: [`${root}/main.mjs`],
        cwd: root,
        env: { ...marker, API_TOKEN: '${LEGACY_TOKEN}' },
        enabled: false,
      },
      'plugin-legacy--extra': {
        type: 'http',
        url: 'https://legacy.example.test/mcp',
        cwd: root,
        env: marker,
        headers: { Authorization: 'Bearer ${LEGACY_TOKEN}' },
        _mixdogPluginDisabled: true,
      },
      'plugin-legacy--gone': { command: 'node', env: marker },
      'plugin-other': { command: 'node', env: { MIXDOG_PLUGIN_ROOT: join(shared.base, 'elsewhere') } },
      mine: { command: 'mine' },
    },
    extensionScopes: { mcp: { 'plugin-legacy--main': [scopeRoot] } },
  };
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  const two = runtime(t, shared, client, { cwd: shared.dir('b'), scopeId: 'two' });

  // Even before anything is persisted, the view treats adoptable copies as plugin servers.
  assert.equal(two.row('plugin-legacy--main').source, 'plugin');

  // Two runtimes adopt concurrently from the same snapshot; patches converge.
  assert.deepEqual(one.api.migratePluginMcpCopies().sort(), ['plugin-legacy--extra', 'plugin-legacy--main']);
  assert.deepEqual(two.api.migratePluginMcpCopies().sort(), ['plugin-legacy--extra', 'plugin-legacy--main']);
  assert.deepEqual(Object.keys(shared.disk.mcpServers).sort(), ['mine', 'plugin-legacy--gone', 'plugin-other']);
  assert.deepEqual(shared.disk.pluginMcp, {
    [id]: {
      main: { alias: 'plugin-legacy--main', enabled: false, env: { API_TOKEN: '${LEGACY_TOKEN}' } },
      extra: { alias: 'plugin-legacy--extra', enabled: false, headers: { Authorization: 'Bearer ${LEGACY_TOKEN}' } },
    },
  });
  // Idempotent.
  assert.deepEqual(one.api.migratePluginMcpCopies(), []);
  assert.deepEqual(two.api.migratePluginMcpCopies(), []);

  const main = one.row('plugin-legacy--main');
  assert.equal(main.source, 'plugin');
  assert.equal(main.owner.key, 'main');
  assert.equal(main.enabled, false);
  assert.deepEqual(main.scope, [scopeRoot]);
  await one.api.setMcpServerEnabled('plugin-legacy--main', true);
  const live = one.live('plugin-legacy--main');
  assert.equal(live.env.API_TOKEN, '${LEGACY_TOKEN}');
  assert.equal(live.env.CLAUDE_PLUGIN_ROOT, root);
  assert.equal(one.row('plugin-legacy--extra').enabled, false);

  // Ambiguous entries stay configured, with a reason.
  const gone = one.row('plugin-legacy--gone');
  assert.equal(gone.source, 'config');
  assert.match(gone.warnings[0], /no longer declares "gone"/);
  assert.match(one.row('plugin-other').warnings[0], /no registered plugin has root/);
  assert.equal(one.row('mine').warnings.length, 0);
});

test('plugin servers fail on unset variables without a default; data dir is made only to connect', async (t) => {
  const shared = workspace(t);
  const root = shared.plugin('strict', {
    '.mcp.json': {
      strict: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/s.mjs', '${MIXDOG_TEST_UNSET_VAR}', '${MIXDOG_TEST_UNSET_OPT:-fallback}'],
      },
    },
  });
  addPlugin(root, { dataDir: shared.dataDir });
  const id = listRegisteredPlugins({ dataDir: shared.dataDir })[0].id;
  const one = runtime(t, shared, null, { cwd: shared.dir('a'), scopeId: 'strict-scope', mcpClient: realMcpClient });
  t.after(() => realMcpClient.disconnectAll({ scopeId: 'strict-scope' }));
  const dataPath = join(shared.dataDir, 'plugins', 'data', id);
  one.api.mcpStatus();
  assert.equal(existsSync(dataPath), false, 'a status read never creates the data dir');
  const status = await one.glue.connectConfiguredMcp();
  const row = status.servers.find((server) => server.name === 'plugin-strict');
  assert.equal(row.status, 'failed');
  assert.match(row.error, /missing environment variable\(s\): MIXDOG_TEST_UNSET_VAR$/);
  assert.equal(existsSync(dataPath), true);
});

test('declaration problems reach status and logs without any configured value', async (t) => {
  const SECRET = 'SENTINEL-tok-31415926';
  const shared = workspace(t);
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  const root = shared.plugin('leaky', {
    'plugin.json': {
      name: 'leaky',
      mcpServers: [
        `missing-${SECRET}.json`,
        { h: { type: 'http', headers: { Authorization: `Bearer ${SECRET}` } } },
        { t: { type: SECRET, url: `https://h/mcp?token=${SECRET}` } },
        { s: { args: [SECRET], env: { TOKEN: SECRET } } },
        { ok: { command: 'node', args: ['ok.mjs'] } },
      ],
    },
  });
  writeFileSync(join(root, '.mcp.json'), `${SECRET} {"x": 1}`);
  const logs = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    logs.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    await one.api.addPlugin(root);
    const status = one.api.mcpStatus();
    assert.equal(status.declarationErrors.length, 5);
    const plugins = one.api.pluginsStatus();
    assert.equal(plugins.plugins.find((plugin) => plugin.name === 'leaky').mcpErrors.length, 5);
    for (const surface of [status, plugins, logs]) assert.ok(!JSON.stringify(surface).includes(SECRET));
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(one.connected(), ['plugin-leaky-ok']);
});

test('migration keeps a tokenized url as an applied override and leaves copies it cannot represent', async (t) => {
  const shared = workspace(t);
  const root = shared.plugin('tok', {
    '.mcp.json': {
      web: { type: 'http', url: 'https://tok.example.test/mcp' },
      cli: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/cli.mjs'] },
    },
  });
  addPlugin(root, { dataDir: shared.dataDir });
  const id = listRegisteredPlugins({ dataDir: shared.dataDir })[0].id;
  const marker = { MIXDOG_PLUGIN_ROOT: root };
  const tokenUrl = 'https://tok.example.test/mcp?token=user-secret-123';
  shared.disk = {
    mcpServers: {
      'plugin-tok--web': { type: 'http', url: tokenUrl, cwd: root, env: marker },
      'plugin-tok--cli': {
        command: 'node',
        args: [`${root}/cli.mjs`, '--fast'],
        cwd: shared.dir('custom'),
        env: marker,
      },
    },
  };
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  assert.deepEqual(one.api.migratePluginMcpCopies(), ['plugin-tok--web']);
  assert.deepEqual(shared.disk.pluginMcp, { [id]: { web: { alias: 'plugin-tok--web', url: tokenUrl } } });
  await one.glue.connectConfiguredMcp();
  assert.equal(one.live('plugin-tok--web').url, tokenUrl, 'the override is applied');
  assert.equal(one.row('plugin-tok--web').source, 'plugin');
  // The changed cwd has no override form: the whole copy stays, nothing lost.
  assert.deepEqual(Object.keys(shared.disk.mcpServers), ['plugin-tok--cli']);
  const cli = one.row('plugin-tok--cli');
  assert.equal(cli.source, 'config');
  assert.match(cli.warnings[0], /"cwd" differ from the plugin declaration/);
  assert.deepEqual(one.live('plugin-tok--cli').args.at(-1), '--fast');
});

test('an unadoptable plugin copy keeps its transport and the plugin lifecycle (disable, project scope)', (t) => {
  const shared = workspace(t);
  const root = shared.plugin('own', {
    '.mcp.json': { cli: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/cli.mjs'] } },
  });
  addPlugin(root, { dataDir: shared.dataDir });
  const [registered] = listRegisteredPlugins({ dataDir: shared.dataDir });
  const custom = shared.dir('custom');
  const config = {
    mcpServers: {
      'plugin-own': {
        command: 'node',
        args: [`${root}/cli.mjs`],
        cwd: custom,
        env: { MIXDOG_PLUGIN_ROOT: root },
      },
    },
  };
  const on = resolveMcpServerCatalog({ config, plugins: [{ ...registered, enabled: true }] });
  assert.equal(on.servers['plugin-own'].cwd, custom, 'the customized transport is honored');
  assert.equal(on.servers['plugin-own'].enabled, true);
  assert.equal(on.servers['plugin-own']._mixdogPlugin.id, registered.id, 'tools carry the plugin id for scoping');
  assert.equal(on.entries['plugin-own'].owner.id, registered.id);
  assert.equal(on.sources['plugin-own'], 'config');
  const off = resolveMcpServerCatalog({ config, plugins: [{ ...registered, enabled: false }] });
  assert.equal(off.servers['plugin-own'].enabled, false);
  assert.equal(off.entries['plugin-own'].pluginEnabled, false);
  // The plugin directory disappearing must not turn its copy into an ownerless server.
  const gone = resolveMcpServerCatalog({ config, plugins: [{ ...registered, enabled: false, exists: false }] });
  assert.equal(gone.servers['plugin-own'].enabled, false, 'a disabled missing plugin keeps its copy off');
  assert.equal(gone.servers['plugin-own']._mixdogPlugin.id, registered.id, 'scoping still sees the plugin id');
  assert.equal(gone.entries['plugin-own'].owner.id, registered.id);
  assert.equal(gone.sources['plugin-own'], 'config', 'the copy is not adopted');
  // A missing duplicate of the same root never shadows the present plugin, whatever the order.
  const ghost = { ...registered, id: 'ghost', enabled: true, exists: false };
  for (const plugins of [
    [{ ...registered, enabled: false }, ghost],
    [ghost, { ...registered, enabled: false }],
  ]) {
    const shadowed = resolveMcpServerCatalog({ config, plugins });
    assert.equal(shadowed.servers['plugin-own'].enabled, false);
    assert.equal(shadowed.entries['plugin-own'].owner.id, registered.id);
  }
});

test('user server CRUD reconciles plugin servers that move names; a collision name sticks', async (t) => {
  const shared = workspace(t);
  shared.disk = { mcpServers: { 'plugin-demo': { command: 'mine' } } };
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  const two = runtime(t, shared, client, { cwd: shared.dir('b'), scopeId: 'two' });
  await one.glue.connectConfiguredMcp();
  await two.glue.connectConfiguredMcp();
  await one.api.addPlugin(shared.plugin('demo', { '.mcp.json': { demo: { command: 'node' } } }));
  const pinned = one.api.mcpStatus().servers.find((server) => server.owner)?.name;
  assert.match(pinned, /^plugin-demo-[0-9a-f]{6}$/);
  // The generated collision name is kept, so it survives the conflict going away.
  const id = one.row(pinned).owner.id;
  assert.deepEqual(shared.disk.pluginMcp, { [id]: { demo: { alias: pinned } } });
  await one.api.removeMcpServer('plugin-demo');
  for (const rt of [one, two]) {
    assert.deepEqual(rt.connected(), [pinned]);
    assert.equal(rt.live(pinned).env.CLAUDE_PLUGIN_ROOT !== undefined, true);
  }
  assert.deepEqual(one.row(pinned).warnings, []);
});

test('without a kept name, removing the conflicting server moves the plugin server and drops the old name', async (t) => {
  const shared = workspace(t);
  // Registered and configured outside the API (no collision name was kept).
  addPlugin(shared.plugin('demo', { '.mcp.json': { demo: { command: 'node' } } }), { dataDir: shared.dataDir });
  shared.disk = { mcpServers: { 'plugin-demo': { command: 'mine' } } };
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  const two = runtime(t, shared, client, { cwd: shared.dir('b'), scopeId: 'two' });
  await one.glue.connectConfiguredMcp();
  await two.glue.connectConfiguredMcp();
  const suffixed = one.api.mcpStatus().servers.find((server) => server.owner).name;
  assert.match(suffixed, /^plugin-demo-[0-9a-f]{6}$/);
  assert.deepEqual(one.connected(), ['plugin-demo', suffixed]);

  await one.api.removeMcpServer('plugin-demo');
  for (const rt of [one, two]) {
    assert.deepEqual(rt.connected(), ['plugin-demo'], 'no orphaned collision-name connection');
    assert.equal(rt.live('plugin-demo').command, 'node', 'connected with the plugin config');
  }
  assert.equal(one.row('plugin-demo').source, 'plugin');
});

test('with MCP disabled, removing a server keeps OAuth credentials a disabled plugin server still uses', async (t) => {
  const shared = workspace(t);
  addPlugin(shared.plugin('tools', toolsFiles), { dataDir: shared.dataDir });
  setPluginEnabled('tools', false, { dataDir: shared.dataDir });
  const other = 'https://other.example.test/mcp';
  shared.disk = {
    mcpServers: { mine: { type: 'http', url: 'https://tools.example.test/mcp' }, other: { type: 'http', url: other } },
  };
  const previous = process.env.MIXDOG_DISABLE_MCP;
  process.env.MIXDOG_DISABLE_MCP = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DISABLE_MCP;
    else process.env.MIXDOG_DISABLE_MCP = previous;
  });
  const cleared = [];
  const one = runtime(t, shared, fakeClient(), {
    cwd: shared.dir('a'),
    scopeId: 'one',
    clearMcpServerOAuth: async (cfg) => cleared.push(cfg.url),
  });
  assert.deepEqual(one.glue.resolveMcpCatalog().servers, {}, 'nothing connects with MCP disabled');
  await one.api.removeMcpServer('mine');
  assert.deepEqual(cleared, []);
  await one.api.removeMcpServer('other');
  assert.deepEqual(cleared, [other]);
  assert.deepEqual(shared.disk.mcpServers, {});
});

test('a server declared enabled:false starts off; the user can turn it on and back', async (t) => {
  const shared = workspace(t);
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  await one.api.addPlugin(
    shared.plugin('opt', { '.mcp.json': { on: { command: 'node' }, off: { command: 'node', enabled: false } } })
  );
  assert.deepEqual(one.connected(), ['plugin-opt-on']);
  assert.equal(one.row('plugin-opt-off').disabledReason, 'server disabled');
  const id = one.row('plugin-opt-off').owner.id;
  await one.api.setMcpServerEnabled('plugin-opt-off', true);
  assert.deepEqual(one.connected(), ['plugin-opt-off', 'plugin-opt-on']);
  assert.deepEqual(shared.disk.pluginMcp, { [id]: { off: { enabled: true } } });
  await one.api.setMcpServerEnabled('plugin-opt-off', false);
  assert.deepEqual(one.connected(), ['plugin-opt-on']);
  assert.deepEqual(shared.disk.pluginMcp || {}, {});
  // The old enable action turns it on too.
  await one.api.enablePluginMcp({ name: 'opt' });
  assert.deepEqual(one.connected(), ['plugin-opt-off', 'plugin-opt-on']);
});

test('the old setup action still works: enable_plugin_mcp turns the plugin servers back on', async (t) => {
  const shared = workspace(t);
  const client = fakeClient();
  const one = runtime(t, shared, client, { cwd: shared.dir('a'), scopeId: 'one' });
  await one.api.addPlugin(shared.plugin('tools', toolsFiles));
  await one.api.setMcpServerEnabled('plugin-tools-a', false);
  const run = async (args) => JSON.parse(await createSetupToolExecutor({ getApi: () => one.api }).execute(args));
  const result = await run({ action: 'enable_plugin_mcp', name: 'tools' });
  assert.equal(result.serverName, 'plugin-tools-a');
  assert.deepEqual(result.serverNames, ['plugin-tools-a', 'plugin-tools-b', 'plugin-tools-local']);
  assert.equal(
    result.mcp.servers.find((server) => server.name === 'plugin-tools-a').plugin,
    one.row('plugin-tools-a').owner.id
  );
  assert.ok(one.connected().includes('plugin-tools-a'));
  assert.deepEqual(shared.disk.pluginMcp || {}, {});
  await assert.rejects(run({ action: 'enable_plugin_mcp', name: 'missing' }), /not found/);
});
