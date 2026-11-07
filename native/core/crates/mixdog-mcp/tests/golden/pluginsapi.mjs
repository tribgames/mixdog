// Records, from today's Node product, what the plugin methods of the runtime API
// (session-runtime/resource-plugins-api.mjs and `setExtensionScope` of resource-api.mjs) answer, the
// config they save, and the order of the host effects they trigger. The plugin folders sit at
// <base>/src/<name> and the data directory at <base>/data, recreated by the Rust replay too;
// <base> is masked in the output, timestamps become <TS>.
// Usage: node pluginsapi.mjs <repo-root> <base-dir> <out.json>
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, out] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createResourceApi } = await load('session-runtime/resource-api.mjs');
const admin = await load('session-runtime/services/plugin-admin.mjs');
const glue = await load('session-runtime/mcp-glue/plugin-servers.mjs');
const { createPluginStatus } = await load('session-runtime/cwd-plugins/plugin-status.mjs');
const { countSkillFiles, pluginManifest } = await load('runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs');

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
};
rmSync(base, { recursive: true, force: true });
for (const [name, files] of Object.entries(fixtures)) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, 'src', name, rel)), { recursive: true });
    writeFileSync(join(base, 'src', name, rel), text);
  }
}
const dataDir = join(base, 'data');
const src = (name) => join(base, 'src', name);
const cwd = join(base, 'proj1', 'sub');

const maskText = (text) =>
  text
    .split(JSON.stringify(base).slice(1, -1)).join('<BASE>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<TS>')
    .replace(/\.corrupt-\d+/g, '.corrupt-<N>')
    .replace(/mixdog-tmp-[0-9a-f]+/g, 'mixdog-tmp-<H>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));

const initialConfig = {
  theme: 'dark',
  mcpServers: {
    'plugin-alpha-plugin': { command: 'node', args: [join(src('alpha'), 's.js')], env: { MIXDOG_PLUGIN_ROOT: src('alpha') } },
    'plugin-beta--b': { url: 'https://b.test/mcp', env: { MIXDOG_PLUGIN_ROOT: src('beta') }, headers: { X: '1' }, enabled: false },
    plain: { command: 'z' },
  },
};
let config = structuredClone(initialConfig);
let events = [];
let saves = [];
const skillsStatus = () => ({
  skills: [{ name: 'deploy', owner: { kind: 'plugin', id: 'x' } }, { name: 'other' }],
});
const deps = {
  getConfig: () => config,
  getCurrentCwd: () => cwd,
  cfgMod: { getPluginData: () => dataDir },
  saveConfigAndAdopt(next) {
    config = structuredClone(next);
    saves.push(structuredClone(next));
    events.push('save');
  },
  // The real pluginsStatus() rows; no MCP summary (no live connection state is modelled here).
  pluginsStatus: createPluginStatus({
    listRegisteredPlugins: admin.listRegisteredPlugins,
    pluginAdminStatus: admin.pluginAdminStatus,
    pluginManifest,
    countSkillFiles,
    clean: (value) => (typeof value === 'string' ? value.trim() : ''),
    resolve,
    statSync,
    existsSync,
    cfgMod: { getPluginData: () => dataDir },
  }).pluginsStatus,
  resolveMcpCatalog: () => glue.resolveMcpServerCatalog({ config, plugins: admin.listRegisteredPlugins({ dataDir }), cwd, dataDir }),
  async flushSkillsSave() {
    events.push('flushSkills');
  },
  invalidateSkills() {
    events.push('invalidateSkills');
  },
  invalidatePreSessionToolSurface() {
    events.push('surface');
  },
  async connectConfiguredMcp(arg) {
    events.push(`connect:${JSON.stringify(arg)}`);
    return {};
  },
  reloadFullConfig() {},
  mcpStatus: () => ({ servers: [] }),
  skillsStatus,
  hooks: {},
};
const api = createResourceApi(deps);

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
  steps.push({
    name,
    method,
    params,
    result: mask(result),
    error: error === null ? null : maskText(error),
    saves: mask(saves),
    events,
    config: mask(config),
  });
};
const status = (name) => step(name, 'plugins/pluginsStatus', {}, () => api.pluginsStatus());
const add = (name, source) => step(name, 'plugins/addPlugin', { source }, () => api.addPlugin(source));
const update = (name, plugin) => step(name, 'plugins/updatePlugin', { plugin }, () => api.updatePlugin(plugin));
const enable = (name, plugin, enabled) => step(name, 'plugins/setPluginEnabled', { plugin, enabled }, () => api.setPluginEnabled(plugin, enabled));
const remove = (name, plugin) => step(name, 'plugins/removePlugin', { plugin }, () => api.removePlugin(plugin));
const scope = (name, kind, target, projects) =>
  step(name, 'config/setExtensionScope', { kind, name: target, ...(projects === undefined ? {} : { projects }) }, () => api.setExtensionScope(kind, target, projects));

await status('status of an empty registry');
await add('add alpha adopts its earlier copy', src('alpha'));
await add('add beta adopts its disabled copy', src('beta'));
await status('status after both');
await scope('scope a plugin by name', 'plugins', 'alpha-plugin', [join(base, 'proj1')]);
await status('status shows the scope and activeHere');
await scope('scope a skill to two projects', 'skills', 'deploy', [join(base, 'proj2'), join(base, 'proj1')]);
await scope('scope a skill back to global', 'skills', 'deploy', null);
await scope('scope a plugin that is not registered', 'plugins', 'nope', []);
await scope('scope an mcp server', 'mcp', 'plain', []);
await scope('scope an unknown kind', 'bogus', 'x', []);
await scope('scope without a name', 'skills', '  ', []);
await enable('disable by name object', { name: 'alpha-plugin' }, false);
await enable('enable by string', 'alpha-plugin', true);
await update('update alpha', { name: 'alpha-plugin' });
await update('update with a blank plugin', {});
await update('update with null', null);
await add('add a blank source', '');
await step('reload', 'plugins/reloadPlugins', {}, () => api.reloadPlugins());
await remove('remove alpha drops its intents', 'alpha-plugin');
await remove('remove an unknown plugin', 'ghost');
await remove('remove beta', { name: 'beta' });
await status('status when everything is removed');
writeFileSync(out, JSON.stringify({ base, fixtures, initialConfig: mask(initialConfig), steps }, null, 1));
