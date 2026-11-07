// Records, from today's Node product, `pluginsStatus()` and `pluginMcpSummary()` while the MCP servers
// of a plugin are really connected: Node's own MCP client (runtime/agent/orchestrator/mcp/client.mjs)
// over the repo's stdio test server (native/core/crates/mixdog-mcp/mock/server.rs), through the real
// `createMcpGlue`. The plugin declares that server (`.mcp.json`) and a second one that is switched off; the steps are: connected, a server dropped, all dropped.
// The test server's path is masked as <MOCK>, the scratch directory as <BASE>.
// Usage: node record-connected.mjs <repo-root> <base-dir> <mock-server-exe>   (the golden JSON goes to stdout)
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, base, mock] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(root, 'src', rel)).href);
const { createMcpGlue } = await load('session-runtime/mcp-glue.mjs');
const { createPluginStatus } = await load('session-runtime/cwd-plugins/plugin-status.mjs');
const admin = await load('session-runtime/services/plugin-admin.mjs');
const { countSkillFiles, pluginManifest } = await load('runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs');
const mcpClient = await load('runtime/agent/orchestrator/mcp/client.mjs');

const json = (value) => JSON.stringify(value);
const fixtures = {
  hub: {
    '.mcp.json': json({
      mcpServers: {
        mock: { command: '<MOCK>' },
        off: { command: '<MOCK>', enabled: false },
      },
    }),
  },
};
const swapMock = (text) => text.split('<MOCK>').join(mock.replace(/\\/g, '\\\\'));
rmSync(base, { recursive: true, force: true });
for (const [name, files] of Object.entries(fixtures)) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(base, 'src', name), { recursive: true });
    writeFileSync(join(base, 'src', name, rel), swapMock(text));
  }
}
const dataDir = join(base, 'data');
const cwd = join(base, 'proj');
mkdirSync(join(dataDir, 'plugins'), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(
  join(dataDir, 'plugins', 'registry.json'),
  json({ version: 1, plugins: [{ id: 'hub-1', name: 'hub', source: join(base, 'src', 'hub'), sourceType: 'local', managed: false, root: join(base, 'src', 'hub'), enabled: true }] })
);

const scopeId = 'rt';
const state = { mcpFailures: [], mcpConnectGeneration: 0, mcpConnectInFlight: null };
const glue = createMcpGlue({
  mcpClient,
  getConfig: () => ({}),
  getCurrentCwd: () => cwd,
  getMcpScopeId: () => scopeId,
  getPluginDataDir: () => dataDir,
  listPlugins: () => admin.listRegisteredPlugins({ dataDir }),
  state,
});
const { pluginsStatus } = createPluginStatus({
  listRegisteredPlugins: admin.listRegisteredPlugins,
  pluginAdminStatus: admin.pluginAdminStatus,
  pluginManifest,
  pluginMcpSummary: glue.pluginMcpSummary,
  countSkillFiles,
  clean: (value) => (typeof value === 'string' ? value.trim() : ''),
  resolve,
  statSync,
  existsSync,
  cfgMod: { getPluginData: () => dataDir },
});

const maskText = (text) => text.split(JSON.stringify(base).slice(1, -1)).join('<BASE>').split(JSON.stringify(mock).slice(1, -1)).join('<MOCK>');
const mask = (value) => JSON.parse(maskText(JSON.stringify(value ?? null)));
const steps = [];
const step = (name) => steps.push({ name, summary: mask(Object.fromEntries(glue.pluginMcpSummary())), status: mask(pluginsStatus()) });

await glue.connectConfiguredMcp({ reconcile: true });
step('connected');
await mcpClient.disconnectMcpServer('plugin-hub-1-mock', { scopeId });
step('the connected server dropped');
await mcpClient.disconnectAll({ scopeId });
step('everything dropped');

console.log(json({ fixtures, steps }));
await mcpClient.disconnectAll({ scopeId });
process.exit(0);
