// Records, from today's Node product, what the MCP server methods of the runtime API
// (session-runtime/resource-mcp-api.mjs and its units) answer, the config they save, and the
// effects they have on the process, in order. The host effects are logged at the boundary the Rust
// service has (reconnect, toggle, publish, announce, connect; keychain and sign-out calls).
// Plugin folders sit at <base>/src/<name>, the data directory at <base>/data; <base> is masked.
// Usage: node mcpapi.mjs <repo-root> <base-dir> <out.json>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createMcpResourceApi } = await load('session-runtime/resource-mcp-api.mjs');
const { createScopeDecorators } = await load('session-runtime/resource-scope-decorate.mjs');
const { createMcpServerInput } = await load('session-runtime/mcp-glue/server-input.mjs');
const client = await load('runtime/agent/orchestrator/mcp/client-config.mjs');
const admin = await load('session-runtime/services/plugin-admin.mjs');
const glue = await load('session-runtime/mcp-glue/plugin-servers.mjs');
const catalogMod = await load('runtime/shared/connector-catalog.mjs');

const mcp = (servers) => JSON.stringify({ mcpServers: servers });
const fixtures = {
  alpha: {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha-plugin', title: 'Alpha' }),
    '.mcp.json': mcp({ search: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js'] } }),
  },
  beta: {
    'plugin.json': JSON.stringify({ name: 'beta' }),
    '.mcp.json': mcp({ a: { command: 'x' }, b: { url: 'https://b.test/mcp' } }),
  },
  empty: { 'plugin.json': JSON.stringify({ name: 'empty-plugin' }) },
};
rmSync(base, { recursive: true, force: true });
for (const [name, files] of Object.entries(fixtures)) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, 'src', name, rel)), { recursive: true });
    writeFileSync(join(base, 'src', name, rel), text);
  }
}
const dataDir = join(base, 'data');
mkdirSync(dataDir, { recursive: true });
const cwd = join(base, 'proj1', 'sub');
const proj1 = join(base, 'proj1');
process.env.USERPROFILE = join(base, 'home');
process.env.HOME = join(base, 'home');

const maskText = (text) =>
  text
    .split(JSON.stringify(base).slice(1, -1))
    .join('<BASE>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const unmask = (value) => JSON.parse(JSON.stringify(value).split('<BASE>').join(JSON.stringify(base).slice(1, -1)));

const notion = {
  type: 'http',
  url: catalogMod.connectorAccountsUrl('notion'),
  connector: 'notion',
  accounts: [
    { name: 'notion', id: 'i1', url: 'https://mcp.notion.com/mcp' },
    { name: 'notion-2', id: 'i2', url: 'https://mcp.notion.com/mcp', oauthKey: 'k2' },
  ],
};
const gmailPw = (email, name) => ({ name, url: 'https://gmail-imap.mixdog.invalid/mcp', headers: { 'X-Mixdog-Gmail-Account': email }, id: `g-${name}` });
const initialConfig = {
  theme: 'dark',
  extensionScopes: { mcp: { web: [proj1] } },
  mcpServers: {
    plain: { command: 'z', args: ['a'], env: { K: 'v' }, note: 'keep' },
    web: { type: 'http', url: 'https://signed.example/mcp', headers: { X: '1' } },
    off: { command: 'o', enabled: false },
    notion,
    gmail: { type: 'http', url: catalogMod.connectorAccountsUrl('gmail'), connector: 'gmail', accounts: [gmailPw('me@example.com', 'gmail')] },
  },
};
let config = structuredClone(initialConfig);
let events = [];
let saves = [];

for (const name of ['alpha', 'beta', 'empty']) admin.addPlugin(join(base, 'src', name), { dataDir });
const plugins = () => admin.listRegisteredPlugins({ dataDir });
const resolveMcpCatalog = () => glue.resolveMcpServerCatalog({ config, plugins: plugins(), cwd, dataDir });
const pluginMcpServer = (name) => {
  const catalog = resolveMcpCatalog();
  const entry = catalog.entries[String(name ?? '').trim()];
  return entry?.owner ? { ...entry, plugin: catalog.plugins[entry.owner.id] } : null;
};
const mcpStatus = () => {
  const catalog = resolveMcpCatalog();
  return {
    servers: Object.entries(catalog.servers).map(([name, cfg]) => {
      const entry = catalog.entries[name];
      return { name, enabled: cfg.enabled !== false, ...(entry?.owner ? { owner: { kind: 'plugin', id: entry.owner.id } } : {}) };
    }),
  };
};
const { normalizeMcpServerInput } = createMcpServerInput({ mcpClient: client, getCurrentCwd: () => cwd });
const oauthState = (cfg) => {
  const url = String(cfg?.url || '');
  if (!url.startsWith('http')) return null;
  return { signedIn: url.includes('signed.example'), account: '' };
};
const deps = {
  getConfig: () => config,
  saveConfigAndAdopt(next) {
    config = structuredClone(next);
    saves.push(structuredClone(next));
    events.push('save');
  },
  normalizeMcpServerInput,
  mcpStatus,
  getMcpServerConfig(name) {
    const server = resolveMcpCatalog().servers[String(name).trim()];
    if (!server) throw new Error(`MCP server not configured: ${String(name).trim()}`);
    return { name, enabled: server.enabled !== false };
  },
  async connectConfiguredMcp(arg) {
    events.push(`connect:${arg.only}:${arg.enabled}`);
    return { connected: arg.only };
  },
  async clearMcpServerOAuth(cfg, options) {
    events.push(`clear:${cfg.name}:${options.revoke}`);
    return cfg.name === 'revoker' ? { revoked: true } : undefined;
  },
  reloadFullConfig() {
    events.push('reload');
  },
  async awaitKeychainPrewarm() {
    events.push('prewarm');
  },
  pluginsStatus: () => admin.pluginAdminStatus({ dataDir }),
  resolveMcpCatalog,
  resolveConfiguredMcpCatalog: resolveMcpCatalog,
  pluginMcpServer,
  async flushSkillsSave() {
    events.push('flushSkills');
  },
  cancelMcpLogin() {},
  completeMcpLogin() {},
  getMcpServerOAuthState: oauthState,
  probeMcpServerAuth: async (probe) => ({ auth: 'oauth', probe }),
  startMcpServerOAuthSwitch() {},
  commitMcpServerOAuthSwitch() {},
  gmailAppPassword: {
    async save(account, password) {
      events.push(`gmailSave:${account}:${password}`);
      if (password.startsWith('bad')) throw new Error('GMAIL_APP_PASSWORD_REJECTED: no');
    },
    async forget(account) {
      events.push(`gmailForget:${account}`);
    },
  },
  async saveOAuthClientSecret(url, secret) {
    events.push(`clientSecret:${url}:${secret}`);
  },
  cfgMod: { getPluginData: () => dataDir },
};
const sync = {
  async reconnectMcpAndAnnounce(o) {
    if (o === undefined) {
      events.push('reconnectAll');
      return { servers: [], reconnected: 'all' };
    }
    const { only = null, enabled = true, drop = [] } = o;
    events.push(`reconnect:${JSON.stringify({ only, enabled, drop })}`);
    return { servers: [], reconnected: only };
  },
  async scheduleMcpToggle(name, enabled) {
    events.push(`toggle:${name}:${enabled}`);
    return { servers: [], toggled: name, enabled };
  },
  async publish(kind, detail) {
    events.push(`publish:${kind}:${JSON.stringify(detail?.mcpChanges)}`);
  },
  async announce(kind, options) {
    events.push(`announce:${kind}:${JSON.stringify(options?.detail?.mcpChanges)}`);
  },
};
const decorators = createScopeDecorators({ getConfig: () => config, getCurrentCwd: () => cwd });
const api = createMcpResourceApi({ deps, sync, decorate: decorators });

const steps = [];
const step = async (name, method, params, fn) => {
  events = [];
  saves = [];
  let result = null;
  let error = null;
  try {
    result = await fn();
  } catch (e) {
    error = e.message;
  }
  steps.push({ name, method, params: mask(params), result: mask(result), error: error === null ? null : maskText(error), saves: mask(saves), events: mask(events), config: mask(config) });
};
const S = (name, method, params, fn) => step(name, method, params, () => fn(unmask(params)));
const pluginServers = Object.keys(resolveMcpCatalog().servers).filter((n) => resolveMcpCatalog().entries[n]?.owner);

await S('status', 'mcp/mcpStatus', {}, () => api.mcpStatus());
await S('config of a server', 'mcp/getMcpServerConfig', { name: 'plain' }, ({ name }) => api.getMcpServerConfig(name));
await S('config of a ghost', 'mcp/getMcpServerConfig', { name: 'ghost' }, ({ name }) => api.getMcpServerConfig(name));
await S('reconnect all', 'mcp/reconnectMcp', {}, () => api.reconnectMcp());
await S('reconnect one', 'mcp/reconnectMcp', { name: ' plain ' }, ({ name }) => api.reconnectMcp(name));
await S('reconnect an account', 'mcp/reconnectMcp', { name: 'notion-2' }, ({ name }) => api.reconnectMcp(name));
await S('reconnect a ghost', 'mcp/reconnectMcp', { name: 'ghost' }, ({ name }) => api.reconnectMcp(name));
await S('reconnect a disabled server', 'mcp/reconnectMcp', { name: 'off' }, ({ name }) => api.reconnectMcp(name));

const add = (name, input) => S(name, 'mcp/addMcpServer', { input }, ({ input }) => api.addMcpServer(input));
await add('add a stdio server', { name: 'My Tool', command: 'node', args: 'a b', env: { A: 1 }, cwd: '~/w', startupTimeoutSec: 5 });
await add('add a remote server', { name: 'remote', url: 'https://r.example/mcp', headers: { H: 'v' }, oauthClientId: 'cid', oauthClientSecret: ' sec ' });
await add('add a taken name', { name: 'plain', command: 'x' });
await add('add an account name', { name: 'notion-2', command: 'x' });
await add('add a plugin server name', { name: pluginServers[0], command: 'x' });
await add('add without a transport', { name: 'nothing' });
await add('add an insecure url', { name: 'insecure', url: 'http://r.example/mcp' });
await add('add an unknown connector', { name: 'zzz', url: 'https://z.example/mcp', connector: 'zzz' });
await add('add a notion account', { name: 'notion', type: 'http', url: 'https://mcp.notion.com/mcp', connector: 'notion' });
await add('add a connector server', { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp', connector: 'linear' });
await add('add a second linear account', { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp', connector: 'linear' });
await add('add a key connector', { name: 'hugging-face', type: 'http', url: 'https://huggingface.co/mcp', headers: { Authorization: 'Bearer k' }, connector: 'hugging-face' });
await add('add a postgres connector', { name: 'postgres', type: 'stdio', command: 'npx', args: ['-y', '@microsoft/postgres-mcp@0.2.0', 'run'], env: { POSTGRES_MCP_CONNECTION_STRING: 'pg://x' }, connector: 'postgres' });
const gm = (name, email, extra = {}) => ({ name, type: 'http', url: 'https://gmail-imap.mixdog.invalid/mcp', headers: { 'X-Mixdog-Gmail-Account': email }, connector: 'gmail', ...extra });
await add('add the same gmail address again', gm('gmail', 'me@example.com', { appPassword: 'abcd efgh ijkl mnop' }));
await add('add another gmail address', gm('gmail', 'two@example.com', { appPassword: 'abcd efgh ijkl mnop' }));
await add('add a gmail account with a bad password', gm('gmail', 'three@example.com', { appPassword: 'short' }));
await add('add a gmail account Gmail rejects', gm('gmail', 'four@example.com', { appPassword: 'badbadbadbadbadb' }));
await add('add a gmail account without a password', gm('gmail', 'five@example.com'));

const save = (name, input) => S(name, 'mcp/saveMcpServer', { input }, ({ input }) => api.saveMcpServer(input));
await save('save a patch', { name: 'plain', args: ['b'], env: { N: '2' }, toolTimeoutSec: 9 });
await save('save a rename', { originalName: 'plain', name: 'plain-renamed', command: 'z2' });
await save('save a rename onto a server', { originalName: 'web', name: 'off' });
await save('save a rename onto an account', { originalName: 'web', name: 'notion-2' });
await save('save an original that is missing', { originalName: 'ghost', name: 'ghost2', command: 'x' });
await save('save a missing plugin original', { originalName: pluginServers[0], name: 'x', command: 'y' });
await save('save a bare plugin name', { name: pluginServers[0], command: 'x' });
await save('save a bare new name', { name: 'fresh', command: 'f' });
await save('save a transport change', { name: 'web', command: 'now-stdio' });
await save('save the client id', { name: 'web', oauthClientId: 'cid2', oauthClientSecret: 'sec2' });
await save('save clearing the client id', { name: 'web', oauthClientId: '' });
await save('save a notion account edit', { name: 'notion-2', originalName: 'notion-2', headers: { A: 'b' }, startupTimeoutSec: 3 });
await save('save an account rename', { originalName: 'notion-2', name: 'notion-9' });
await save('save the server itself', { name: 'notion', originalName: 'notion', url: 'https://connectors.mixdog.invalid/notion/mcp', startupTimeoutSec: 7 });
await save('save a gmail account password', { name: 'gmail', originalName: 'gmail', appPassword: 'abcd efgh ijkl mnop' });
await save('save a gmail account bad password', { name: 'gmail', originalName: 'gmail', appPassword: 'x' });
await save('save without a name', { command: 'x' });

const remove = (name, serverName) => S(name, 'mcp/removeMcpServer', { name: serverName }, ({ name }) => api.removeMcpServer(name));
await remove('remove a server', 'fresh');
await remove('remove a server with a client secret', 'web');
await remove('remove a notion account', 'notion-2');
await remove('remove the other notion account', 'notion');
await remove('remove a gmail server', 'gmail');
await remove('remove a ghost', 'ghost');
await remove('remove a plugin server', pluginServers[0]);
await remove('remove with no name', '  ');
await remove('remove an account that is gone', 'notion-2');

const toggle = (name, serverName, enabled) => S(name, 'mcp/setMcpServerEnabled', { name: serverName, enabled }, ({ name, enabled }) => api.setMcpServerEnabled(name, enabled));
await toggle('disable a server', 'plain-renamed', false);
await toggle('enable a server', 'plain-renamed', true);
await toggle('disable a plugin server', pluginServers[0], false);
await toggle('enable a plugin server', pluginServers[0], true);
await toggle('disable an account', 'linear-2', false);
await toggle('enable an account', 'linear-2', true);
await toggle('disable the last account', 'linear-2', false);
await toggle('disable the other account', 'linear', false);
await toggle('enable the server by its name', 'linear', true);
await toggle('toggle a ghost', 'ghost', true);
await toggle('toggle with no name', '', true);

const enable = (name, plugin) => S(name, 'mcp/enablePluginMcp', { plugin }, ({ plugin }) => api.enablePluginMcp(plugin));
await enable('enable plugin servers by name', { name: 'alpha-plugin' });
await enable('enable plugin servers of beta', { id: 'beta' });
await enable('enable a plugin that is not registered', { name: 'nope' });
await enable('enable a plugin without servers', { name: 'empty-plugin' });

await S('sign out of a signed-in server', 'mcp/signOutMcpServer', { name: 'web' }, ({ name }) => api.signOutMcpServer(name));
await S('sign out of a server that does not use oauth', 'mcp/signOutMcpServer', { name: 'off' }, ({ name }) => api.signOutMcpServer(name));
await S('sign out of a ghost', 'mcp/signOutMcpServer', { name: 'ghost' }, ({ name }) => api.signOutMcpServer(name));
await S('sign out with no name', 'mcp/signOutMcpServer', { name: '' }, ({ name }) => api.signOutMcpServer(name));
await S('sign out of an account server', 'mcp/signOutMcpServer', { name: 'linear' }, ({ name }) => api.signOutMcpServer(name));
await S('begin on a ghost', 'mcp/beginMcpOAuthLogin', { name: 'ghost' }, ({ name }) => api.beginMcpOAuthLogin(name));
await S('begin on a disabled server', 'mcp/beginMcpOAuthLogin', { name: 'plain-renamed' }, ({ name }) => api.beginMcpOAuthLogin(name));
await S('begin on a server without oauth', 'mcp/beginMcpOAuthLogin', { name: 'off' }, ({ name }) => api.beginMcpOAuthLogin(name));
await S('begin a switch while signed out', 'mcp/beginMcpOAuthLogin', { name: 'remote', options: { mode: 'switch' } }, ({ name, options }) => api.beginMcpOAuthLogin(name, options));
await S('probe without a config', 'mcp/probeMcpServerAuth', { cfg: null }, ({ cfg }) => api.probeMcpServerAuth(cfg));
await S('probe a stdio config', 'mcp/probeMcpServerAuth', { cfg: { type: 'stdio', command: 'x' } }, ({ cfg }) => api.probeMcpServerAuth(cfg));
await S('probe an http config', 'mcp/probeMcpServerAuth', { cfg: { type: 'http', url: 'https://p.example/mcp', name: 'dropped', headers: { A: 'b' } } }, ({ cfg }) => api.probeMcpServerAuth(cfg));

const account = (name, input) => S(name, 'connector/addConnectorAccount', { input }, ({ input }) => api.addConnectorAccount(input));
await account('connector account for an unknown connector', { connector: 'nope' });
await account('connector account without a connector', {});
await account('connector account of a sign-in connector', { connector: 'notion' });
await account('another account of a sign-in connector', { connector: ' notion ' });
await account('connector account of a new sign-in connector', { connector: 'jira' });
await account('connector account with the own client', { connector: 'sentry', oauthClientId: ' own ', oauthClientSecret: ' shh ' });
await account('connector account of a google connector', { connector: 'google-drive' });
await account('key connector without a key', { connector: 'stripe' });
await account('key connector with a key', { connector: 'stripe', key: ' rk_live_1 ' });
await account('key connector with a second key', { connector: 'stripe', key: 'rk_live_2' });
await account('postgres with a connection string', { connector: 'postgres', key: 'postgresql://u:p@h/db' });
await account('gmail without an address', { connector: 'gmail', appPassword: 'abcd efgh ijkl mnop' });
await account('gmail with a short password', { connector: 'gmail', email: 'a@b.co', appPassword: 'short' });
await account('gmail with an address and password', { connector: 'gmail', email: ' New@Example.com ', appPassword: 'abcd efgh ijkl mnop' });
await account('gmail with a password Gmail rejects', { connector: 'gmail', email: 'bad@example.com', appPassword: 'badbadbadbadbadb' });
await account('gmail with an address already connected', { connector: 'gmail', email: 'me@example.com', appPassword: 'wxyz wxyz wxyz wxyz' });

const { createAgentConnectorsApi } = await load('session-runtime/workflow-agents-api/agent-connectors.mjs');
const toolList = [
  { name: 'mcp__notion__search', description: 'Search.', annotations: { readOnlyHint: true } },
  { name: 'mcp__notion__create', annotations: { readOnlyHint: false, x: 1 } },
  { name: 'mcp__notion__plain' },
  { name: 'short', mcpServerName: 'notion', mcpToolName: 'fetch', description: 'Fetch.', annotations: 'str' },
  { name: 'mcp__notion__named', mcpServerName: 'notion' },
  { name: 'nothing', mcpServerName: 'notion' },
  { name: 'mcp__notion-2__t' },
  { name: 'mcp__other__t' },
  { name: 'mcp__plugin_mixdog_mixdog__read', description: 'self' },
  { name: 'not-mcp' },
  { name: 'mcp__a__b__c' },
  { name: 'mcp__x', description: 5 },
];
for (const connectorId of ['notion', 'notion-2', 'a', 'plugin_mixdog_mixdog', 'absent', '']) {
  await S(`tools of ${connectorId || 'nothing'}`, 'connector/listConnectorTools', { connectorId, tools: toolList }, ({ connectorId, tools }) =>
    createAgentConnectorsApi({ mcpStatus, getMcpTools: () => tools, getConfig: () => config, saveConfigAndAdopt: deps.saveConfigAndAdopt, resolveConfiguredMcpCatalog: resolveMcpCatalog }, {}).listConnectorTools(connectorId)
  );
}

writeFileSync(out, JSON.stringify({ base, fixtures, initialConfig: mask(initialConfig), steps }, null, 1));
console.log(steps.length, 'steps', steps.filter((s) => s.error).length, 'errors');
