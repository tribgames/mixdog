// Records, from today's Node product, what `pluginsStatus()` (session-runtime/cwd-plugins/plugin-status.mjs)
// answers over a set of plugin folders: its rows (skill count, hook files, MCP declaration, sort,
// warnings, invalid manifests), the `missing` list, and the `pluginMcpSummary()` it reads
// (mcp-glue/server-catalog.mjs) with the MCP servers connected or not. The plugin folders sit at
// <base>/src/<name> and the data directory at <base>/data, recreated by the Rust replay; <base> is
// masked as <BASE> in the output.
// Usage: node pluginsrows.mjs <repo-root> <base-dir>   (the golden JSON goes to stdout)
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createMcpGlue } = await load('session-runtime/mcp-glue.mjs');
const { createPluginStatus } = await load('session-runtime/cwd-plugins/plugin-status.mjs');
const admin = await load('session-runtime/services/plugin-admin.mjs');
const { countSkillFiles, pluginManifest } = await load('runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs');

const json = (value) => JSON.stringify(value);
const fixtures = {
  alpha: {
    'plugin.json': json({
      name: 'Alpha',
      title: 'Alpha Tools',
      version: '1.2.0',
      description: 'The alpha plugin',
      author: { name: 'A', email: 'a@x.test', url: 'https://a.test' },
      homepage: 'https://alpha.test',
      repository: { url: 'https://git.test/alpha' },
      license: { type: 'MIT' },
      keywords: ['k1', ' ', 2, 'k2'],
      mcpServers: { search: { command: 'node', args: ['s.js'] }, bad: { type: 'stdio' } },
    }),
    'skills/one/SKILL.md': '---\nname: one\n---\n',
    'skills/nested/deep/skill.md': '---\nname: deep\n---\n',
    'skills/mixed/Skill.MD': 'x',
    'skills/README.md': 'not a skill',
    'hooks/hooks.json': '{}',
  },
  beta: {
    '.claude-plugin/plugin.json': json({ name: 'beta', skills: ['./extra', './skills', '../outside', '/abs', 5, ''] }),
    '.mcp.json': json({ mcpServers: { a: { command: 'x' }, b: { url: 'https://b.test/mcp' } } }),
    'extra/a/SKILL.md': 'x',
    'skills/b/SKILL.md': 'x',
    '.mixdog/hooks.json': '{}',
  },
  gamma: {
    '.codex-plugin/plugin.json': json({ name: 'gamma', mcpServers: './servers/mcp.json', skills: './SKILL.md' }),
    'servers/mcp.json': json({ srv: { command: 'c' } }),
    'SKILL.md': 'x',
  },
  delta: {},
  epsilon: {
    'plugin.json': '[1,2]',
    '.claude-plugin/plugin.json': json({ name: 'eps-claude' }),
  },
  zeta: {
    'plugin.json': '{"name": ',
    'skills/z/SKILL.md': 'x',
  },
  eta: {
    'plugin.json': json({ name: 'eta', mcpServers: [{ x: { command: 'x' } }, './m1.json', 5, '../m2.json'] }),
    'm1.json': json({ mcpServers: { y: { url: 'https://y.test' } } }),
  },
  theta: {
    '.mcp.json': json({ t: { command: 't' } }),
  },
  kappa: {},
};
rmSync(base, { recursive: true, force: true });
for (const [name, files] of Object.entries(fixtures)) {
  mkdirSync(join(base, 'src', name), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, 'src', name, rel)), { recursive: true });
    writeFileSync(join(base, 'src', name, rel), text);
  }
}
const dataDir = join(base, 'data');
const src = (name) => join(base, 'src', name);
const entry = (name, fields) => ({ root: src(name), ...fields });
const registry = [
  entry('alpha', { id: 'alpha-1', source: 'https://git.test/alpha.git', url: 'https://git.test/alpha.git', sourceType: 'git', managed: true, name: 'alpha', title: 'a', version: '0.1', description: 'old', enabled: true, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }),
  entry('beta', { id: 'beta-1', source: src('beta'), sourceType: 'local', managed: false, enabled: true }),
  entry('gamma', { id: 'gamma-1', source: src('gamma'), sourceType: 'local', enabled: false, installedAt: '' }),
  entry('delta', { id: 'delta-1', name: 'delta-entry', source: 'o/delta', sourceType: 'local', managed: false }),
  entry('epsilon', { id: 'epsilon-1', name: 'Epsilon', source: 'o/epsilon' }),
  entry('zeta', { id: 'zeta-1', name: 'zeta', source: 'o/zeta' }),
  entry('eta', { id: 'eta-1', source: 'o/eta', sourceType: 'git' }),
  entry('theta', { name: 'Theta', source: 'o/theta' }),
  entry('kappa', { id: 'kappa-1', name: 'kappa', source: 'o/kappa', enabled: false }),
  { id: 'iota-1', name: 'iota', source: 'o/iota', root: join(base, 'src', 'gone') },
  { name: 'only-name', root: join(base, 'src', 'gone2'), enabled: false },
  { id: 'rootless', name: 'rootless', source: 'o/r' },
];
mkdirSync(join(dataDir, 'plugins'), { recursive: true });
writeFileSync(join(dataDir, 'plugins', 'registry.json'), json({ version: 1, plugins: registry }));

// A fake connection registry, as plugin-mcp-live.test.mjs has it: a server the glue connects is live.
const live = new Map();
const mcpClient = {
  resolveMcpTransportKind: (cfg) => (cfg.url ? 'http' : 'stdio'),
  getMcpServerStatus: () => [...live.keys()].map((name) => ({ name, connected: true, toolCount: 1, tools: [] })),
  async connectMcpServers(servers) {
    for (const [name, cfg] of Object.entries(servers)) if (cfg.enabled !== false) live.set(name, cfg);
  },
  async reconnectSingleMcpServer(_scope, name, cfg) {
    live.set(name, cfg);
    return true;
  },
  async disconnectMcpServer(name) {
    live.delete(name);
  },
  async disconnectAll() {
    live.clear();
  },
  setMcpScopeRoot() {},
};

let config = {};
const cwd = join(base, 'proj');
mkdirSync(cwd, { recursive: true });
const state = { mcpFailures: [], mcpConnectGeneration: 0, mcpConnectInFlight: null };
const glue = createMcpGlue({
  mcpClient,
  getConfig: () => config,
  getCurrentCwd: () => cwd,
  getMcpScopeId: () => 'rt',
  getPluginDataDir: () => dataDir,
  listPlugins: () => admin.listRegisteredPlugins({ dataDir }),
  state,
});
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const { pluginsStatus } = createPluginStatus({
  listRegisteredPlugins: admin.listRegisteredPlugins,
  pluginAdminStatus: admin.pluginAdminStatus,
  pluginManifest,
  pluginMcpSummary: glue.pluginMcpSummary,
  countSkillFiles,
  clean,
  resolve,
  statSync,
  existsSync,
  cfgMod: { getPluginData: () => dataDir },
});

const maskText = (text) => text.split(JSON.stringify(base).slice(1, -1)).join('<BASE>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const summaryOf = () => Object.fromEntries(glue.pluginMcpSummary());
const steps = [];
const step = (name, connected) => {
  steps.push({ name, config: mask(config), connected, summary: mask(summaryOf()), status: mask(pluginsStatus()) });
};

step('every fixture, nothing connected', false);
await glue.connectConfiguredMcp({ reconcile: true });
step('the plugin servers connected', true);
// A server the user switched off, and a plugin whose key an intent names.
config = { pluginMcp: { 'alpha-1': { search: { enabled: false } } } };
await glue.connectConfiguredMcp({ reconcile: true });
step('one declared server switched off', true);
config = {};
live.clear();
rmSync(src('beta'), { recursive: true, force: true });
rmSync(join(src('alpha'), 'hooks'), { recursive: true, force: true });
writeFileSync(join(src('delta'), 'plugin.json'), json({ name: 'delta', skills: 'skills' }));
mkdirSync(join(src('delta'), 'skills'));
writeFileSync(join(src('delta'), 'skills', 'SKILL.md'), 'x');
step('a root removed, hooks removed, a skill added', false);

rmSync(join(dataDir, 'plugins', 'registry.json'));
step('no registry', false);

console.log(JSON.stringify({ fixtures, registry: mask(registry), steps }, null, 1));
process.exit(0);
