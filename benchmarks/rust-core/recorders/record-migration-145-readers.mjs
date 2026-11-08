#!/usr/bin/env node
// Adds to a recorded migration-145 set what 1.4.5 answers for the stores the migration leaves in place that
// `record-migration-145.mjs` does not cover: the MCP servers and the usage dashboard. It runs the 1.4.5 code over a
// copy of the set's own `.mixdog` (so the answers stand for exactly the recorded data), writes
// `<set>/readers.json` and refreshes the set's MANIFEST with the tag's commit.
//
//   node benchmarks/rust-core/recorders/record-migration-145-readers.mjs --tree <git clone at tag v1.4.5 with node_modules> --out <the migration-145 set>
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveTree, tagCheckoutIdentity, writeSetManifest } from './lib/common.mjs';

const RELEASE_TAG = 'v1.4.5';
const args = parseArgs();
const tree = resolveTree(args);
const identity = tagCheckoutIdentity(tree, RELEASE_TAG);
const out = args.get('out') ? resolve(args.get('out')) : null;
if (!out) throw new Error('--out <the migration-145 set> is required');
const root = `${out}.readers-live`;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
cpSync(join(out, '.mixdog'), join(root, '.mixdog'), { recursive: true });
const home = join(root, '.mixdog');
const data = join(home, 'data');
const workdir = join(root, 'work');
mkdirSync(workdir, { recursive: true });
for (const key of ['HOME', 'USERPROFILE']) process.env[key] = root;
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
// Nothing of the real user profile is reachable from this run.
for (const [key, sub] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['MIXDOG_DESKTOP_USER_DATA', 'desktop'], ['MIXDOG_CONFIG_DIR', 'config'], ['MIXDOG_RUNTIME_ROOT', 'runtime']]) process.env[key] = join(root, sub);
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8')).guardEnv)) {
  if (k !== 'MIXDOG_DISABLE_MCP' && k !== 'MIXDOG_DISABLE_SKILLS') process.env[k] = v;
}
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DISABLE_PROVIDER_WARMUP = '1';
const at = (p) => import(pathToFileURL(join(tree, p)).href);
const jsonSafe = (v) => JSON.parse(JSON.stringify(v ?? null));
const answered = (fn) => {
  try {
    return jsonSafe(fn());
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const cfgMod = await at('src/runtime/shared/config.mjs');
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const answers = {};

// The usage dashboard in its preview form, which fetches nothing. The setup it is built from is 1.4.5's own
// `providerSetup` over this data, kept as an input so a reader can be given the same one.
const dashConfig = jsonSafe((await at('src/runtime/agent/orchestrator/config.mjs')).loadConfig({ secrets: false }));
const setup = jsonSafe(await admin.providerSetup(dashConfig, { detectLocal: false }));
const { createUsageDashboard } = await at('src/session-runtime/services/usage-dashboard.mjs');
const dashboard = jsonSafe(await createUsageDashboard(dashConfig, { setup, preview: true }));
answers.usageDashboard = { config: dashConfig, setup, answer: dashboard };

// MCP servers through the real client with nothing connected: every configured server is listed as it stands on disk.
const { createMcpServerCatalog } = await at('src/session-runtime/mcp-glue/server-catalog.mjs');
const catalog = createMcpServerCatalog({
  mcpClient: await at('src/runtime/agent/orchestrator/mcp/client.mjs'),
  getConfig: () => cfgMod.readSection('agent'),
  getCurrentCwd: () => workdir,
  getMcpScopeId: () => 'rt',
  getPluginDataDir: () => data,
  listPlugins: () => [],
  state: { mcpFailures: [] },
});
answers.mcp = { status: jsonSafe(catalog.mcpStatus()), configs: {} };
for (const name of Object.keys(cfgMod.readSection('agent').mcpServers ?? {})) answers.mcp.configs[name] = answered(() => catalog.getMcpServerConfig(name));

writeFileSync(join(out, 'readers.json'), `${JSON.stringify(answers, null, 2)}\n`);
rmSync(root, { recursive: true, force: true });
writeSetManifest(out, {
  set: 'migration-145',
  recorder: 'benchmarks/rust-core/recorders/record-migration-145.mjs',
  command: `node benchmarks/rust-core/recorders/record-migration-145.mjs --tree <git clone at ${RELEASE_TAG}> --out <fixture dir>, then node benchmarks/rust-core/recorders/record-migration-145-readers.mjs --tree <the same clone> --out <fixture dir> (adds readers.json)`,
  identity,
});
console.error('readers done');