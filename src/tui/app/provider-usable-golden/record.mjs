// Records the provider-setup rows of a custom provider (invalid, then valid) from Node at b6f10295a into
// node-rows.golden.json: the rows `providerSetup` (session-runtime/services/provider-admin.mjs) answered.
//   node record.mjs <node-repo> [out.json]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNodeTree } from '../../components/status-line/footer-golden/node-tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-rows.golden.json');
if (!repo) throw new Error('usage: node record.mjs <node-repo> [out.json]');
const { tree, commit } = exportNodeTree(repo);

const child = `
import { pathToFileURL } from 'node:url';
const { providerSetup } = await import(pathToFileURL(process.env.NODE_TREE + '/src/session-runtime/services/provider-admin.mjs').href);
const id = 'custom-0b7e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d';
const entry = { type: 'custom', schemaVersion: 2, name: 'Broken', protocol: 'openai-chat', baseURL: 'https://gw.example.com/v1', enabled: true, auth: 'none', modelOverrides: { m: { contextWindow: '4096' } } };
const row = async (e) => (await providerSetup({ providers: { [id]: e } }, { checkSecrets: false })).api.find((r) => r.id === id);
const invalid = await row(entry);
const valid = await row({ ...entry, modelOverrides: { m: { contextWindow: 4096 } } });
process.stdout.write(JSON.stringify({ invalid, valid }));
process.exit(0);
`;
const home = join(tree, 'home');
const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
  cwd: tree,
  encoding: 'utf8',
  env: { ...process.env, NODE_TREE: tree, MIXDOG_DATA_DIR: join(home, 'data'), MIXDOG_HOME: home, MIXDOG_CONFIG_DIR: home },
});
if (run.status !== 0) throw new Error(run.stderr);
writeFileSync(out, `${JSON.stringify({ recordedFrom: commit, ...JSON.parse(run.stdout) }, null, 1)}\n`);
