// Records Node's real Anthropic OAuth listing (`AnthropicOAuthProvider.listModels`) against a loopback stand-in for
// api.anthropic.com, in an isolated data dir with the seeded metadata layers of the model-list recorder, and what it
// leaves in `anthropic-oauth-models.json`. Three runs: no cache (two calls: one fetch, then a cache hit), a fresh
// cache and a stale one, each counting the requests that reached the stub.
// Writes native/core/fixtures/oauth-model-cache/node-oauth-model-cache.json.
//   node benchmarks/rust-core/recorders/oauth-model-cache/record.mjs --tree <tree>
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const treeAt = process.argv.indexOf('--tree');
if (treeAt < 0 || !process.argv[treeAt + 1]) throw new Error('usage: record.mjs --tree <tree>');
const NODE_TREE = resolve(process.argv[treeAt + 1]);
const RUN_ROOT = mkdtempSync(join(tmpdir(), 'oauth-model-cache-'));
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
const seeds = JSON.parse(readFileSync(join(HERE, '..', 'model-lists', 'seeds.json'), 'utf8'));
const HOUR = 3_600_000;

// What GET /v1/models answers: the shape of the live endpoint, release dates far ahead (the sanitizer is clock based).
const effort = (...levels) => ({ supported: true, ...Object.fromEntries(levels.map((l) => [l, { supported: true }])) });
const stubBody = {
  data: [
    { id: 'claude-opus-4-8', type: 'model', display_name: 'Claude Opus 4.8', created_at: '2093-06-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { effort: effort('low', 'medium', 'high', 'xhigh', 'max'), thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } } } },
    { id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4.6', created_at: '2090-06-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 64000, capabilities: { effort: effort('low', 'medium', 'high'), thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } } } },
    { id: 'claude-haiku-4-5-20251001', type: 'model', display_name: 'Claude Haiku 4.5', created_at: '2091-06-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000, capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } } } },
    // A model no catalog layer knows: the row Node caches for it is bare.
    { id: 'claude-mystery-4-9', type: 'model', display_name: 'Claude Mystery 4.9', created_at: '2094-06-01T00:00:00Z' },
  ],
  has_more: false,
};

let hits = 0;
const stub = http.createServer((request, response) => {
  if (new URL(request.url, 'http://127.0.0.1').pathname === '/v1/models') hits += 1;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(stubBody));
});
await new Promise((done) => stub.listen(0, '127.0.0.1', done));
const stubOrigin = `http://127.0.0.1:${stub.address().port}`;

async function run(name, seedCache) {
  const root = join(RUN_ROOT, name);
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  writeFileSync(join(dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: now, data: seeds.modelsDev }));
  writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: now, data: seeds.litellm }));
  writeFileSync(join(dataDir, 'update-check-cache.json'), JSON.stringify({ latestVersion: '1.4.5', lastCheckedAt: now }));
  writeFileSync(join(dataDir, 'anthropic-oauth-credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'recorded-access-token', refreshToken: 'recorded-refresh-token', expiresAt: now + 365 * 24 * HOUR, scopes: ['user:inference'], subscriptionType: 'max' } }));
  if (seedCache) writeFileSync(join(dataDir, 'anthropic-oauth-models.json'), JSON.stringify(seedCache(now)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.test(k)));
  Object.assign(env, { MIXDOG_HOME: join(home, '.mixdog'), MIXDOG_DATA_DIR: dataDir, HOME: home, USERPROFILE: home, TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), NO_PROXY: '127.0.0.1,localhost' });
  hits = 0;
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', join(HERE, 'child.mjs'), NODE_TREE, stubOrigin], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise((done) => child.once('exit', done));
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`${name}: no result (exit ${code})\n${stdout}\n${stderr}`);
  const result = JSON.parse(line.slice(7));
  console.log(`${name}: stub hits ${hits}, rows ${result.first.length}/${result.second.length}`);
  return { ...result, hits };
}

const cold = await run('cold', null);
// The cold run's own file, re-dated, is the seed of the other two.
const dated = (hoursAgo) => (now) => ({ ...cold.cacheFile, fetchedAt: now - hoursAgo * HOUR });
const fresh = await run('fresh', dated(1));
const stale = await run('stale', dated(25));
stub.close();

const OUT = join(HERE, '..', '..', '..', '..', 'native', 'core', 'fixtures', 'oauth-model-cache', 'node-oauth-model-cache.json');
mkdirSync(dirname(OUT), { recursive: true });
rmSync(RUN_ROOT, { recursive: true, force: true });
writeFileSync(OUT, `${JSON.stringify({ stubBody, cold, fresh: { seededHoursAgo: 1, ...fresh }, stale: { seededHoursAgo: 25, ...stale } }, null, 2)}\n`);
