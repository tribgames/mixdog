// Records, from today's Node product, what the `setup` tool does for the MCP, skills, plugins and
// connectors actions (setup-tool/executor.mjs SETUP_ACTION_HANDLERS, extended-actions.mjs
// get_mcp_server): the calls it makes on the runtime facade and the result it answers. The
// receipt (`saved`, `scope`, `appliesTo`) belongs to the dispatcher and is left out; only calls
// that got past the tool-input validation are kept.
// Usage: node setupmcp.mjs <repo-root> <out.json>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const { createSetupToolExecutor } = await import(pathToFileURL(join(root, 'src', 'session-runtime', 'setup-tool', 'executor.mjs')).href);

const STATUS = {
  connectedCount: '2',
  servers: [
    { name: 'plain', enabled: true, connected: true, transport: 'stdio', toolCount: 3, source: 'config', error: null, scope: ['/p'] },
    { name: 'off', enabled: false, type: 'http', toolCount: '5', error: 'boom', scope: 'x', warnings: [], extra: 'dropped' },
    { name: 'plugin-a-s', owner: { kind: 'plugin', id: 'a', key: 's' }, disabledReason: 'plugin off', source: 'plugin', warnings: ['w1'] },
    { name: 'plugin-b-s', owner: { kind: 'plugin', id: 'b', key: 't' }, connected: true },
    { name: 'owned', owner: { kind: 'user', id: 'z' } },
    { name: 'notion', connector: 'notion', connected: true, accounts: [{ name: 'notion', email: 'a@b.co', authRequired: true, error: 'x' }, { name: 'notion-2' }, { name: 'n3', email: null, error: '' }] },
    { name: 'gmail', connector: 'gmail', connected: false, accounts: [] },
  ],
  warnings: [{ message: 'w' }],
  declarationErrors: [{ message: 'd' }],
};
const EMPTY = {};
const CONFIGS = {
  plain: { name: 'plain', source: 'config', enabled: true, config: { type: 'stdio', command: 'node', args: ['a', 'b'], env: { K: 'v' }, cwd: '/w', env_vars: ['A'] } },
  web: { name: 'web', source: 'config', enabled: false, config: { type: 'http', url: 'https://u:p@web.example:8443/mcp?token=1', headers: { X: '1' }, bearer_token_env_var: 'TOK', env_http_headers: { H: 'E' } } },
  badurl: { name: 'badurl', source: 'config', config: { url: 'not a url', args: 'x' } },
  plugin: { name: 'ps', source: 'plugin', owner: { kind: 'plugin', id: 'p1', key: 'k' }, enabled: true, config: { command: 'x' } },
  bare: { name: 'bare', source: 'config' },
};
const PLUGINS = { plugins: [{ id: 'p1', name: 'alpha' }, { id: 'p2', name: 'beta' }, { id: 'p3', name: 'gamma' }] };

let calls = [];
let reached = false;
const record = (name, ...args) => calls.push([name, ...args]);
const facade = {
  async addMcpServer(server) {
    record('addMcpServer', server);
    return server.name === 'nameless' ? { status: STATUS } : { name: `${server.name}!`, status: STATUS };
  },
  async saveMcpServer(server) {
    record('saveMcpServer', server);
    return { name: server.originalName || server.name, status: server.name === 'empty' ? EMPTY : STATUS };
  },
  async removeMcpServer(name) {
    record('removeMcpServer', name);
    return STATUS;
  },
  async setMcpServerEnabled(name, enabled) {
    record('setMcpServerEnabled', name, enabled);
    return EMPTY;
  },
  async reconnectMcp(name) {
    record('reconnectMcp', name ?? null);
    return STATUS;
  },
  mcpStatus: () => STATUS,
  async getMcpServerConfig(name) {
    record('getMcpServerConfig', name ?? null);
    const row = CONFIGS[String(name ?? '').trim()];
    if (!row) throw new Error(`MCP server not configured: ${String(name ?? '').trim()}`);
    return row;
  },
  async setDisabledSkills(names) {
    record('setDisabledSkills', names);
    return { disabled: names };
  },
  async setExtensionScope(kind, name, projects) {
    record('setExtensionScope', kind, name, projects);
    if (kind === 'mcp') return STATUS;
    if (kind === 'plugins') return PLUGINS;
    return name === 'null' ? null : { skills: [] };
  },
  async addPlugin(source) {
    record('addPlugin', source);
    return source === 'none' ? {} : { plugin: { id: 'x', source } };
  },
  async updatePlugin(name) {
    record('updatePlugin', name);
    return name === 'none' ? null : { plugin: { id: name, updated: true } };
  },
  async setPluginEnabled(name, enabled) {
    record('setPluginEnabled', name, enabled);
    return { plugin: { id: name, enabled } };
  },
  async removePlugin(name) {
    record('removePlugin', name);
    return { plugin: null };
  },
  pluginsStatus: () => PLUGINS,
  async enablePluginMcp(plugin) {
    record('enablePluginMcp', plugin);
    return plugin.id === 'p2' ? { serverName: 's9', status: EMPTY } : { serverName: 's1', serverNames: ['s1', 's2'], status: STATUS };
  },
};
const executor = createSetupToolExecutor({
  getApi: () => {
    reached = true;
    return facade;
  },
  getSessionId: () => '',
});

const cases = [];
const run = async (args) => {
  calls = [];
  reached = false;
  let result = null;
  let error = null;
  try {
    const raw = await executor.execute(args);
    result = JSON.parse(raw);
    delete result.saved;
    delete result.scope;
    delete result.appliesTo;
  } catch (e) {
    error = e.message;
  }
  if (reached) cases.push({ args, result, error, calls });
};

const server = (extra) => ({ action: 'add_mcp_server', server: { name: 'srv', command: 'node', ...extra } });
for (const args of [
  server({}),
  server({ args: ['a'], env: { K: 'ENV_K' } }),
  { action: 'add_mcp_server', server: { name: 'web', url: 'https://web.example/mcp' } },
  { action: 'add_mcp_server', server: { name: 'nameless', command: 'x' } },
  { action: 'add_mcp_server', server: { name: 'noroute' } },
  { action: 'add_mcp_server', server: { command: 'x' } },
  { action: 'add_mcp_server' },
  { action: 'add_mcp_server', server: 'str' },
  server({ env: { API_KEY: 'secret' } }),
  server({ env: { API_KEY: null } }),
  server({ headers: { Authorization: 'Bearer x' } }),
  server({ headers: { 'X-Cookie': 'c' } }),
  server({ headers: { Accept: 'json' } }),
  { action: 'add_mcp_server', server: { name: 'w', url: 'ftp://x.example/' } },
  { action: 'add_mcp_server', server: { name: 'w', url: 'not a url' } },
  { action: 'add_mcp_server', server: { name: 'w', url: 'https://u:p@x.example/' } },
  { action: 'add_mcp_server', server: { name: 'w', url: 'https://x.example/?api_key=1' } },
  { action: 'add_mcp_server', server: { name: 'w', url: 'https://x.example/?q=1&Auth=2' } },
  { action: 'add_mcp_server', server: { name: 'w', url: 'wss://x.example/ws' } },
  { action: 'add_mcp_server', server: { name: 'w', url: 'https://x.example/', command: 'x' } },
  { action: 'add_mcp_server', server: { name: 'w', type: 'stdio', url: 'https://x.example/' } },
  { action: 'add_mcp_server', server: { name: 'w', type: 'http', command: 'x' } },
  { action: 'add_mcp_server', server: { name: 'w', type: 'stdio', command: 'x' } },
  { action: 'save_mcp_server', server: { name: 'plain', args: ['b'] } },
  { action: 'save_mcp_server', server: { originalName: 'plain', name: 'renamed' } },
  { action: 'save_mcp_server', server: { originalName: ' plain ' } },
  { action: 'save_mcp_server', server: { name: 'empty' } },
  { action: 'save_mcp_server', server: {} },
  { action: 'save_mcp_server', server: { originalName: '  ', name: '  ' } },
  { action: 'remove_mcp_server', name: ' plain ' },
  { action: 'remove_mcp_server', name: '' },
  { action: 'remove_mcp_server' },
  { action: 'set_mcp_enabled', name: 'plain', enabled: false },
  { action: 'set_mcp_enabled', name: 'plain', enabled: true },
  { action: 'set_mcp_enabled', name: 'plain', enabled: 'yes' },
  { action: 'set_mcp_enabled', name: 'plain' },
  { action: 'set_mcp_enabled', enabled: true },
  { action: 'reconnect_mcp' },
  { action: 'reconnect_mcp', name: ' plain ' },
  { action: 'reconnect_mcp', name: '  ' },
  { action: 'get_mcp_server', name: 'plain' },
  { action: 'get_mcp_server', name: 'web' },
  { action: 'get_mcp_server', name: 'badurl' },
  { action: 'get_mcp_server', name: 'plugin' },
  { action: 'get_mcp_server', name: 'bare' },
  { action: 'get_mcp_server', name: 'ghost' },
  { action: 'get_mcp_server' },
  { action: 'set_disabled_skills', skills: [' a ', '', 'b', 5, null] },
  { action: 'set_disabled_skills', skills: [] },
  { action: 'set_disabled_skills', skills: 'a' },
  { action: 'set_disabled_skills' },
  { action: 'set_extension_scope', kind: 'mcp', name: 'plain', projects: [' /p ', ''] },
  { action: 'set_extension_scope', kind: 'plugins', name: 'alpha', projects: [] },
  { action: 'set_extension_scope', kind: 'skills', name: 'deploy', projects: ['/a'] },
  { action: 'set_extension_scope', kind: 'skills', name: 'null', projects: [] },
  { action: 'set_extension_scope', kind: 'bogus', name: 'x', projects: [] },
  { action: 'set_extension_scope', kind: 'mcp', name: ' ', projects: [] },
  { action: 'set_extension_scope', kind: 'mcp', name: 'x' },
  { action: 'set_extension_scope', kind: 'mcp', name: 'x', projects: null },
  { action: 'set_extension_scope', kind: 'mcp', name: 'x', projects: 'str' },
  { action: 'add_plugin', source: ' ./plug ' },
  { action: 'add_plugin', source: 'none' },
  { action: 'add_plugin', source: '' },
  { action: 'update_plugin', name: 'alpha' },
  { action: 'update_plugin', name: 'none' },
  { action: 'update_plugin' },
  { action: 'set_plugin_enabled', name: 'alpha', enabled: false },
  { action: 'set_plugin_enabled', name: 'alpha' },
  { action: 'remove_plugin', name: ' alpha ' },
  { action: 'remove_plugin', name: '' },
  { action: 'connect_connector', connector: 'notion' },
  { action: 'connect_connector', connector: ' gmail ' },
  { action: 'connect_connector', connector: 'stripe' },
  { action: 'connect_connector', connector: 'google-drive' },
  { action: 'connect_connector', connector: 'nope' },
  { action: 'connect_connector' },
  { action: 'enable_plugin_mcp', name: 'alpha' },
  { action: 'enable_plugin_mcp', name: 'p2' },
  { action: 'enable_plugin_mcp', name: 'ghost' },
  { action: 'enable_plugin_mcp' },
]) await run(args);

writeFileSync(out, JSON.stringify({ fixtures: { STATUS, CONFIGS, PLUGINS }, cases }, null, 1));
console.log(cases.length, 'cases kept', cases.filter((c) => c.error).length, 'errors');
