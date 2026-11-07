// Records, from today's Node product, what the `setup` tool's plugin actions ask of the runtime
// (setup-tool/executor.mjs) and how the protocol layer names it: each runtime call as a method of the
// protocol with its named params, and whether the method takes the calling session (`thread`,
// standalone/protocol-session/method-args.generated.mjs) - the runtime is the calling session's.
// Usage: node record-setup-calls.mjs <repo-root>   (the golden JSON goes to stdout)
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createSetupToolExecutor } = await load('session-runtime/setup-tool/executor.mjs');
const { METHOD_ARGS } = await load('standalone/protocol-session/method-args.generated.mjs');

const NAMES = {
  addPlugin: 'plugins/addPlugin',
  updatePlugin: 'plugins/updatePlugin',
  setPluginEnabled: 'plugins/setPluginEnabled',
  removePlugin: 'plugins/removePlugin',
  pluginsStatus: 'plugins/pluginsStatus',
  setExtensionScope: 'config/setExtensionScope',
};
let calls = [];
const record = (name, ...args) => {
  const method = NAMES[name];
  const { thread, args: names } = METHOD_ARGS[method];
  calls.push({ method, thread, params: Object.fromEntries(names.map((key, index) => [key, args[index]])) });
};
const PLUGINS = { plugins: [{ id: 'p1', name: 'alpha' }] };
const facade = {
  async addPlugin(source) { record('addPlugin', source); return { plugin: { id: 'x', source } }; },
  async updatePlugin(name) { record('updatePlugin', name); return { plugin: { id: name } }; },
  async setPluginEnabled(name, enabled) { record('setPluginEnabled', name, enabled); return { plugin: { id: name, enabled } }; },
  async removePlugin(name) { record('removePlugin', name); return { plugin: null }; },
  async setExtensionScope(kind, name, projects) { record('setExtensionScope', kind, name, projects); return PLUGINS; },
  pluginsStatus: () => { record('pluginsStatus'); return PLUGINS; },
};
const executor = createSetupToolExecutor({ getApi: () => facade, getSessionId: () => '' });
const cases = [];
for (const args of [
  { action: 'add_plugin', source: ' ./p ' },
  { action: 'set_plugin_enabled', name: 'alpha', enabled: false },
  { action: 'update_plugin', name: 'alpha' },
  { action: 'remove_plugin', name: 'alpha' },
  { action: 'set_extension_scope', kind: 'plugins', name: 'alpha', projects: [' /a '] },
  { action: 'status', domain: 'plugins' },
]) {
  calls = [];
  await executor.execute(args);
  cases.push({ args, calls });
}
console.log(JSON.stringify({ cases }, null, 1));
process.exit(0);
