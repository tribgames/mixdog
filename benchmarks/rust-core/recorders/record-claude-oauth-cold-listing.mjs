#!/usr/bin/env node
// Node's cold `anthropic-oauth` model listing (`AnthropicOAuthProvider.listModels` in anthropic-oauth.mjs) with no
// credential and no roster cache: `_fetchModelCatalog` -> `ensureAuth` awaits `warmCliVersion` before it finds no
// credential, then `listModels` answers its offline `MODELS` rows. Each scenario runs in its own Node process (the
// live claude-code version is module state) over scripted fetches; the recording holds every request Node made, in
// order, and the rows the listing answered. Rust's `anthropic-oauth` source (the adapter behind `VersionedAdapter`,
// read through `ModelSource`) must make the same requests and answer the same rows.
//
//   node benchmarks/rust-core/recorders/record-claude-oauth-cold-listing.mjs --tree <export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/claude-oauth-cold-listing/golden.json (+ MANIFEST.json, identity exact at the commit).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, productIdentity, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-claude-oauth-cold-listing.mjs';
const SCENARIOS = [
  { name: 'registry-answers', env: {}, net: [{ status: 200, body: JSON.stringify({ version: '2.1.500' }) }] },
  { name: 'registry-unreachable', env: {}, net: [{ fail: true }] },
  { name: 'version-named', env: { MIXDOG_CLI_VERSION: '2.1.400' }, net: [{ status: 200, body: JSON.stringify({ version: '2.1.500' }) }] },
];
const ENV_KEYS = ['MIXDOG_CLI_VERSION', 'MIXDOG_DISABLE_LIVE_CLI_VERSIONS', 'ANTHROPIC_OAUTH_CREDENTIALS_PATH', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];

const args = parseArgs();
const tree = resolveTree(args);

if (args.has('child')) {
  const scenario = SCENARIOS.find((s) => s.name === args.get('child'));
  // A dispatcher that is not undici's own `Agent`: `preconnect` (http-agent.mjs) then opens no socket.
  const undici = await import(pathToFileURL(join(tree, 'node_modules', 'undici', 'index.js')).href);
  class NoNetwork extends undici.Dispatcher {
    dispatch(_options, handler) {
      handler.onError(new Error('offline'));
      return false;
    }
  }
  undici.setGlobalDispatcher(new NoNetwork());
  const fetched = [];
  const queue = [...scenario.net];
  globalThis.fetch = async (url, opts) => {
    fetched.push({ method: opts?.method ?? 'GET', url: String(url) });
    const next = queue.shift();
    if (!next || next.fail) throw new Error('offline');
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => JSON.parse(next.body), text: async () => next.body };
  };
  const { AnthropicOAuthProvider } = await import(pathToFileURL(join(tree, 'src', 'runtime', 'agent', 'orchestrator', 'providers', 'anthropic-oauth.mjs')).href);
  const rows = await new AnthropicOAuthProvider({}).listModels();
  process.stdout.write(`RESULT ${JSON.stringify({ fetched, rows })}\n`);
  process.exit(0);
}

const results = [];
for (const scenario of SCENARIOS) {
  const env = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  const root = mkdtempSync(join(tmpdir(), 'claude-oauth-cold-'));
  Object.assign(env, { MIXDOG_DATA_DIR: join(root, 'data'), MIXDOG_HOME: join(root, 'home'), HOME: root, USERPROFILE: root }, scenario.env);
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--child', scenario.name], { env, encoding: 'utf8' });
  const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (run.status !== 0 || !line) throw new Error(`${scenario.name}: exit ${run.status}\n${run.stdout}\n${run.stderr}`);
  results.push({ name: scenario.name, env: scenario.env, net: scenario.net, ...JSON.parse(line.slice(7)) });
}

const identity = productIdentity(tree, NODE_COMMIT);
if (!identity.refComparison.exact) throw new Error(`the tree is not an exact export of ${NODE_COMMIT}: ${JSON.stringify(identity.refComparison)}`);
const finalDir = join(FIXTURES_ROOT, 'claude-oauth-cold-listing');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { scenarios: results });
writeSetManifest(stage, { set: 'claude-oauth-cold-listing', recorder, command: `node ${recorder} --tree <tree>`, identity });
commitStage(stage, finalDir);
